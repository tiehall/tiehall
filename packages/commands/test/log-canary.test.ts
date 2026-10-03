import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createExecute,
  createLogger,
  createRestHandler,
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
import { addUser } from "./support/members.ts";

// The log canary (self-host-install: Logs carry ids, never message text or
// credentials; design.md, Technical decisions: T17). A background job for a
// message fails while it holds the message's text and a token, and says both
// in its error. The worker's log names the job and the message by their ids,
// and neither the text nor the token appears anywhere in it. A REST request
// that fails carries the same canary text in its body and a canary token in
// its Authorization header and its query string, and its handler says all of
// them in its error; neither appears in the log, or anywhere else the process
// writes while it answers.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CANARY_TEXT = `Please rotate the staging keys; canary-${randomBytes(8).toString("hex")}`;
const CANARY_TOKEN = `th_pat_${randomBytes(20).toString("hex")}`;
/** The member the canary token acts for. */
const AGENT_USER = randomUUID();
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
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
  await addUser(owner, { userId: AGENT_USER });
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
      const deadline = Date.now() + 30_000;
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

describe("a REST request that fails while carrying message text and a token", () => {
  const catalog = defineCatalog([
    defineCommand({
      id: "probes.post",
      summary: "Post a message on a request.",
      input: z.object({ key: z.string(), body: z.string() }),
      output: z.object({ messageId: z.string() }),
      method: "POST",
      path: "/api/v1/probes/{key}/messages",
      scopes: ["requests:write"],
      commitment: false,
      confirm: false,
      surfaces: ["rest"],
      stability: "alpha",
    }),
  ]);

  it("leaves neither the text nor the token in the log, nor anywhere the process writes", async () => {
    const lines: string[] = [];
    const url = `https://tiehall.example.com/api/v1/probes/FE-142/messages?token=${CANARY_TOKEN}`;
    const execute = createExecute({
      catalog,
      handlers: {
        // Fails the way a tracker call does, echoing everything it was sent.
        "probes.post": async (input) => {
          const { body } = input as { body: string };
          const request = { url, headers: { authorization: `Bearer ${CANARY_TOKEN}` }, body: JSON.stringify({ body }) };
          throw Object.assign(new Error(`Could not post "${body}" to ${url} with Bearer ${CANARY_TOKEN}`, { cause: new Error(body) }), { request });
        },
      },
      store: { database: db, jobs: queue },
    });
    const rest = createRestHandler({
      catalog,
      document: "{}\n",
      execute,
      authenticate: async (request) =>
        request.headers.get("authorization") === `Bearer ${CANARY_TOKEN}`
          ? { kind: "personal_access_token", userId: AGENT_USER, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" }
          : undefined,
      logger: createLogger({ write: (line) => lines.push(line) }),
    });

    // Everything the process writes while it answers, besides the logger's own lines.
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    let response: Response;
    try {
      response = await rest(
        new Request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${CANARY_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ body: CANARY_TEXT }),
        }),
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(response.status).toBe(500);
    const answer = await response.text();
    const log = [...lines, ...written].join("\n");
    for (const text of [log, answer]) {
      expect(text).not.toContain(CANARY_TEXT);
      expect(text).not.toContain("canary-");
      expect(text).not.toContain(CANARY_TOKEN);
      expect(text).not.toContain(CANARY_TOKEN.slice("th_pat_".length));
      expect(text).not.toContain("token=");
    }
    // The log names the operation that failed and how, by its ids and the error's name.
    expect(lines.map((line) => JSON.parse(line) as LogEntry)).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "rest: the operation failed",
        operationId: "probes.post",
        error: expect.objectContaining({ name: "Error", cause: expect.objectContaining({ name: "Error" }) }),
      }),
    ]);
  });
});
