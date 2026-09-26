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
  withOrg,
  write,
  type Database,
  type DatabaseConnection,
  type JobQueue,
  type LogEntry,
  type RunningJob,
} from "../src/index.ts";

// The worker stops gracefully (self-host-install: A restart stops the app
// gracefully; design.md, Technical decisions: T6). On stop, which SIGTERM
// triggers, it takes no new job, lets its active jobs finish within the stop
// timeout, and releases the ones that do not, so they run again once a worker
// starts after the restart: no job is lost.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const silent = createLogger({ write: () => {} });
const settings = { retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false, expireInSeconds: 60 };
const quick = defineJobType<{ requestId: string }>("probe.quick", 1, settings);
const slow = defineJobType<{ requestId: string }>("probe.slow", 1, settings);

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
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  app = { connectionString: url.toString(), password: appRole.password };
  db = openDatabase(app);
  queue = await openJobQueue({ connection: app, jobTypes: [quick, slow], logger: silent });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await queue.stop();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

async function send(type: typeof quick, requestId: string): Promise<void> {
  await write({ database: db, jobs: queue }, { actorKind: "system" }, async (writer) => {
    await writer.record(messagePosted, { requestId, messageId: randomUUID() });
    await writer.enqueue(type, { requestId });
  });
}

async function stateOf(queueName: string): Promise<{ id: string; state: string }[]> {
  const { rows } = await owner.query<{ id: string; state: string }>(
    "SELECT id, state::text AS state FROM pgboss.job WHERE name = $1",
    [queueName],
  );
  return rows;
}

/** A logger that keeps its lines, parsed. */
function capturing(): { logger: ReturnType<typeof createLogger>; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: createLogger({ write: (line) => entries.push(JSON.parse(line) as LogEntry) }), entries };
}

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, seconds = 20): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("stopping the worker", () => {
  it("finishes the active jobs it can, releases the rest, and a released job runs again after a restart", async () => {
    const started: string[] = [];
    const { logger, entries } = capturing();
    const worker = await startWorker({
      connection: app,
      jobs: [
        {
          type: quick,
          handle: async (job: RunningJob<{ requestId: string }>) => {
            started.push(`quick ${job.id}`);
            await sleep(400);
          },
        },
        {
          type: slow,
          // Runs until the worker gives it up.
          handle: async (job: RunningJob<{ requestId: string }>) => {
            started.push(`slow ${job.id}`);
            await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
          },
        },
      ],
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 1500,
      logger,
    });
    expect(entries.map(({ msg }) => msg)).toEqual(["worker: started, working 2 queues"]);
    expect(entries[0]).toMatchObject({ level: "info", queues: [quick.queue, slow.queue] });

    await send(slow, randomUUID());
    await until("the slow job to start", () => (started.some((each) => each.startsWith("slow")) ? true : undefined));
    await send(quick, randomUUID());
    await until("the quick job to start", () => (started.some((each) => each.startsWith("quick")) ? true : undefined));

    const stopping = Date.now();
    await worker.stop();
    expect(Date.now() - stopping).toBeLessThan(10_000);

    const [finished] = await stateOf(quick.queue);
    expect(finished?.state).toBe("completed");
    const [released] = await stateOf(slow.queue);
    expect(released?.state).toBe("retry");
    expect(entries.at(-1)).toMatchObject({
      level: "info",
      msg: "worker: stopped; released 1 active job, which runs again after the restart",
      released: [{ queue: slow.queue, jobId: released?.id }],
    });

    // After the restart, a worker takes the released job again, and this time it finishes.
    const rerun: string[] = [];
    const restarted = await startWorker({
      connection: app,
      jobs: [{ type: slow, handle: async (job: RunningJob<{ requestId: string }>) => void rerun.push(job.id) }],
      pollingIntervalSeconds: 0.5,
      logger: silent,
    });
    try {
      await until("the released job to run again", () => (rerun.length > 0 ? true : undefined));
      expect(rerun).toEqual([released?.id]);
      await until("the released job to complete", async () =>
        (await stateOf(slow.queue))[0]?.state === "completed" ? true : undefined,
      );
    } finally {
      await restarted.stop();
    }
  });

  it("stops at once when no job is active", async () => {
    const { logger, entries } = capturing();
    const worker = await startWorker({
      connection: app,
      jobs: [{ type: quick, handle: async () => {} }],
      pollingIntervalSeconds: 0.5,
      logger,
    });
    const stopping = Date.now();
    await worker.stop();
    expect(Date.now() - stopping).toBeLessThan(3000);
    expect(entries.map(({ msg }) => msg)).toEqual(["worker: started, working 1 queue", "worker: stopped"]);
  });
});

// self-host-install: A restart stops the app gracefully. A database restart ends the connections idling in the
// worker's pool; the worker logs the loss, keeps running, and the next job gets a new connection.
describe("when the database ends the worker's connections", () => {
  it("logs the loss by its code, keeps running, and runs the next job on a new connection", async () => {
    const ran: string[] = [];
    const { logger, entries } = capturing();
    const worker = await startWorker({
      connection: app,
      jobs: [
        {
          type: quick,
          handle: async (job: RunningJob<{ requestId: string }>, services) => {
            ran.push(await withOrg(services.database, async ({ orgId }) => `${job.data.requestId} in ${orgId}`));
          },
        },
      ],
      pollingIntervalSeconds: 0.5,
      logger,
    });
    try {
      const first = randomUUID();
      await send(quick, first);
      await until("the first job to run", () => (ran.some((each) => each.startsWith(first)) ? true : undefined));
      await until("the first job to complete", async () =>
        (await stateOf(quick.queue)).every(({ state }) => state === "completed") ? true : undefined,
      );

      // As a database restart does: every session of the worker ends, the idle ones in its pool included.
      const { rows } = await owner.query<{ ended: boolean }>(
        "SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name = 'tiehall worker' AND usename = $1",
        [appRole.name],
      );
      expect(rows.length).toBeGreaterThan(0);
      const lost = await until("the worker to log the lost connection", () =>
        entries.find(({ msg }) => msg === "worker: the database ended an idle connection; the next query opens a new one"),
      );
      expect(lost).toMatchObject({ level: "warn", error: { code: "57P01" } });
      expect(lost).not.toHaveProperty("error.message");

      const second = randomUUID();
      await send(quick, second);
      await until("the next job to run", () => (ran.some((each) => each.startsWith(second)) ? true : undefined));
    } finally {
      await worker.stop();
    }
  }, 30_000);
});
