import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messagePosted } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createLogger,
  defineJobType,
  migrate,
  openDatabase,
  openJobQueue,
  startWorker,
  write,
  type Database,
  type DatabaseConnection,
  type JobQueue,
  type LogEntry,
  type RunningJob,
  type WorkerServices,
} from "../src/index.ts";

// The log canary (self-host-install: Logs carry ids, never message text or
// credentials; design.md, Technical decisions: T17). A background job for a
// message fails while it holds the message's text and a token, and says both
// in its error. The worker's log names the job and the message by their ids,
// and neither the text nor the token appears anywhere in it.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CANARY_TEXT = `Please rotate the staging keys; canary-${randomBytes(8).toString("hex")}`;
const CANARY_TOKEN = `th_pat_${randomBytes(20).toString("hex")}`;
const mirrorMessage = defineJobType<{ messageId: string }>("probe.mirror_message", 1, {
  retryLimit: 0,
  retryDelaySeconds: 0,
  retryBackoff: false,
  expireInSeconds: 60,
});

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let app: DatabaseConnection;
let queue: JobQueue;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query(
    `CREATE TABLE probe_messages (org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), body text NOT NULL,
       PRIMARY KEY (org_id, id))`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  app = { connectionString: url.toString(), password: appRole.password };
  db = openDatabase(app);
  queue = await openJobQueue({ connection: app, jobTypes: [mirrorMessage], logger: createLogger({ write: () => {} }) });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await queue.stop();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

/** Mirrors a message into a tracker that refuses it, echoing everything it was sent, as trackers do. */
async function mirrorIntoRefusingTracker(job: RunningJob<{ messageId: string }>, { database: jobDb }: WorkerServices) {
  const { rows } = await jobDb.$client.query<{ body: string }>("SELECT body FROM probe_messages WHERE id = $1", [
    job.data.messageId,
  ]);
  const text = rows[0]?.body ?? "";
  const request = {
    url: `https://acme.atlassian.net/rest/api/3/issue?token=${CANARY_TOKEN}`,
    headers: { authorization: `Bearer ${CANARY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ summary: text }),
  };
  const refusal = new Error(`Jira answered 400 to ${request.url}: ${text}`);
  throw Object.assign(new Error(`Could not mirror "${text}" with ${CANARY_TOKEN}`, { cause: refusal }), { request });
}

describe("a background job that fails while holding message text and a token", () => {
  it("leaves neither in the log, which names the job and the message by their ids", async () => {
    const lines: string[] = [];
    const worker = await startWorker({
      connection: app,
      jobs: [{ type: mirrorMessage, handle: mirrorIntoRefusingTracker }],
      pollingIntervalSeconds: 0.5,
      logger: createLogger({ write: (line) => lines.push(line) }),
    });
    let messageId = "";
    let jobId = "";
    try {
      await write({ database: db, jobs: queue }, { actorKind: "system" }, async (writer) => {
        const { rows } = await writer.tx.execute<{ id: string }>(
          `INSERT INTO probe_messages (org_id, body) VALUES ('${writer.orgId}', ${pg.escapeLiteral(CANARY_TEXT)}) RETURNING id`,
        );
        messageId = rows[0]?.id ?? "";
        await writer.record(messagePosted, { requestId: randomUUID(), messageId });
        await writer.enqueue(mirrorMessage, { messageId });
      });
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await owner.query<{ id: string; state: string }>(
          "SELECT id, state::text AS state FROM pgboss.job WHERE name = $1",
          [mirrorMessage.queue],
        );
        if (rows[0]?.state === "failed") {
          jobId = rows[0].id;
          break;
        }
        if (Date.now() > deadline) throw new Error(`The job did not fail: ${JSON.stringify(rows)}`);
        await sleep(100);
      }
    } finally {
      await worker.stop();
    }

    const log = lines.join("\n");
    expect(log).not.toContain(CANARY_TEXT);
    expect(log).not.toContain("canary-");
    expect(log).not.toContain(CANARY_TOKEN);
    expect(log).not.toContain(CANARY_TOKEN.slice("th_pat_".length));
    const entries = lines.map((line) => JSON.parse(line) as LogEntry);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "worker: job failed",
        queue: mirrorMessage.queue,
        jobId,
        ids: { messageId },
        error: expect.objectContaining({ name: "Error", cause: expect.objectContaining({ name: "Error" }) }),
      }),
    );
  });
});
