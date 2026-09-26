import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getRollbackPlans } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { messagePosted, type Provenance } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createLogger,
  defineJobType,
  installJobQueue,
  JOB_QUEUE_VERSION,
  migrate,
  openDatabase,
  openJobQueue,
  startWorker,
  write,
  type Database,
  type DatabaseConnection,
  type JobQueue,
  type RunningJob,
  type Worker,
} from "../src/index.ts";

// The job queue (design.md, Technical decisions: T5 and T6; self-host-install:
// Migrations expand, then contract). pg-boss keeps the queues in Postgres, in a
// schema the migrate step installs as the database owner; the app role uses it
// and owns none of it. A write sends its jobs inside its own transaction, so a
// job exists only once the write commits. A queue's name carries the version of
// its jobs' data shape, so a worker of the previous release, which works only
// the queues it knows, never receives a job of the next shape.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const silent = createLogger({ write: () => {} });
const fast = { retryLimit: 1, retryDelaySeconds: 0, retryBackoff: false, expireInSeconds: 60 };
const mirrorV1 = defineJobType<{ requestId: string }>("probe.mirror_request", 1, fast);
const mirrorV2 = defineJobType<{ requestId: string; teamId: string }>("probe.mirror_request", 2, fast);
const alwaysFails = defineJobType<{ requestId: string }>("probe.always_fails", 1, fast);
const agent: Provenance = { actorKind: "agent", userId: randomUUID(), surface: "mcp" };

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let app: DatabaseConnection;
let queue: JobQueue;
const workers: Worker[] = [];
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
  queue = await openJobQueue({ connection: app, jobTypes: [mirrorV1, mirrorV2, alwaysFails], logger: silent });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.stop()));
  await queue.stop();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM events; DELETE FROM event_sequence;
     DELETE FROM pgboss.job; COMMIT`,
  );
});

/** Records a message event and sends a mirror job in one write, then runs `after` inside it. */
function postAndMirror<D extends { requestId: string }>(
  type: typeof mirrorV1 | typeof mirrorV2 | typeof alwaysFails,
  data: D,
  after: () => Promise<void> = async () => {},
) {
  return write({ database: db, jobs: queue }, agent, async (writer) => {
    await writer.record(messagePosted, { requestId: data.requestId, messageId: randomUUID() });
    await writer.enqueue(type as typeof mirrorV2, data as never);
    await after();
  });
}

async function jobsIn(queueName: string): Promise<{ state: string; data: unknown }[]> {
  const { rows } = await owner.query<{ state: string; data: unknown }>(
    "SELECT state::text AS state, data FROM pgboss.job WHERE name = $1 ORDER BY created_on",
    [queueName],
  );
  return rows;
}

/** A worker, stopped after the test, that records the jobs it receives. */
async function recordingWorker(types: (typeof mirrorV1 | typeof mirrorV2)[]): Promise<RunningJob<{ requestId: string }>[]> {
  const received: RunningJob<{ requestId: string }>[] = [];
  const worker = await startWorker({
    connection: app,
    jobs: types.map((type) => ({ type, handle: async (job: RunningJob<{ requestId: string }>) => void received.push(job) })),
    pollingIntervalSeconds: 0.5,
    logger: silent,
  });
  workers.push(worker);
  return received;
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

describe("the job queue's schema", () => {
  it("is installed by the migrate step and owned by the database owner, not the app role", async () => {
    const { rows } = await owner.query<{ owner: string; app_can_create: boolean; app_can_use: boolean }>(
      `SELECT pg_get_userbyid(nspowner) AS owner, has_schema_privilege($1, 'pgboss', 'CREATE') AS app_can_create,
              has_schema_privilege($1, 'pgboss', 'USAGE') AS app_can_use
         FROM pg_namespace WHERE nspname = 'pgboss'`,
      [appRole.name],
    );
    expect(rows).toEqual([
      { owner: decodeURIComponent(new URL(database.url).username), app_can_create: false, app_can_use: true },
    ]);
    const version = await owner.query("SELECT version FROM pgboss.version");
    expect(version.rows).toHaveLength(1);
  });

  it("has a queue with the job type's settings and a dead-letter queue for each job type", async () => {
    const { rows } = await owner.query(
      `SELECT name, dead_letter, retry_limit, retry_delay, retry_backoff, expire_seconds FROM pgboss.queue
        WHERE name LIKE 'probe.%' AND name NOT LIKE '%.dead_letter' ORDER BY name`,
    );
    const settings = { retry_limit: 1, retry_delay: 0, retry_backoff: false, expire_seconds: 60 };
    expect(rows).toEqual([
      { name: "probe.always_fails.v1", dead_letter: "probe.always_fails.v1.dead_letter", ...settings },
      { name: "probe.mirror_request.v1", dead_letter: "probe.mirror_request.v1.dead_letter", ...settings },
      { name: "probe.mirror_request.v2", dead_letter: "probe.mirror_request.v2.dead_letter", ...settings },
    ]);
    const deadLetters = await owner.query(
      "SELECT name, dead_letter FROM pgboss.queue WHERE name LIKE 'probe.%.dead_letter' ORDER BY name",
    );
    expect(deadLetters.rows).toEqual([
      { name: "probe.always_fails.v1.dead_letter", dead_letter: null },
      { name: "probe.mirror_request.v1.dead_letter", dead_letter: null },
      { name: "probe.mirror_request.v2.dead_letter", dead_letter: null },
    ]);
  });

  it("is installed once, however often migrate runs", async () => {
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    expect((await owner.query("SELECT count(*)::int AS versions FROM pgboss.version")).rows).toEqual([{ versions: 1 }]);
  });
});

describe("sending a job inside a write", () => {
  it("enqueues nothing when the transaction rolls back", async () => {
    const requestId = randomUUID();
    await expect(
      postAndMirror(mirrorV1, { requestId }, async () => {
        throw new Error("the write failed after sending its job");
      }),
    ).rejects.toThrow("the write failed after sending its job");
    expect(await jobsIn(mirrorV1.queue)).toEqual([]);
  });

  it("enqueues the job when the transaction commits, and a worker receives it only then", async () => {
    const received = await recordingWorker([mirrorV1]);
    const requestId = randomUUID();
    await postAndMirror(mirrorV1, { requestId }, async () => {
      // The worker polls every half second; nothing reaches it while the write is open.
      await sleep(1500);
      expect(received).toEqual([]);
    });
    expect(await jobsIn(mirrorV1.queue)).toEqual([{ state: expect.any(String), data: { requestId } }]);
    const [job] = await until("the worker to receive the job", () => (received.length > 0 ? received : undefined));
    expect(job?.data).toEqual({ requestId });
    expect(job?.queue).toBe(mirrorV1.queue);
  });
});

describe("queue versions", () => {
  it("never give a worker on the previous version a job of the next one", async () => {
    // The previous release's worker knows only version 1.
    const previous = await recordingWorker([mirrorV1]);
    const oldJob = { requestId: randomUUID() };
    const newJob = { requestId: randomUUID(), teamId: randomUUID() };
    await postAndMirror(mirrorV2, newJob);
    await postAndMirror(mirrorV1, oldJob);
    await until("the previous worker to receive its own job", () => (previous.length > 0 ? previous : undefined));
    await sleep(2000);
    expect(previous.map(({ data }) => data)).toEqual([oldJob]);
    expect(await jobsIn(mirrorV2.queue)).toEqual([{ state: "created", data: newJob }]);

    // The next release's worker takes it.
    const next = await recordingWorker([mirrorV2]);
    const [job] = await until("the next worker to receive the new job", () => (next.length > 0 ? next : undefined));
    expect(job?.data).toEqual(newJob);
  });
});

describe("dead-letter queues", () => {
  it("receive a job once its attempts are used up", async () => {
    const attempts: string[] = [];
    workers.push(
      await startWorker({
        connection: app,
        jobs: [
          {
            type: alwaysFails,
            handle: async (job: RunningJob<{ requestId: string }>) => {
              attempts.push(job.id);
              throw new Error("the tracker refused the call");
            },
          },
        ],
        pollingIntervalSeconds: 0.5,
        logger: silent,
      }),
    );
    const requestId = randomUUID();
    await postAndMirror(alwaysFails, { requestId });
    const dead = await until("the job to reach the dead-letter queue", async () => {
      const jobs = await jobsIn(alwaysFails.deadLetterQueue);
      return jobs.length > 0 ? jobs : undefined;
    });
    expect(dead).toEqual([{ state: "created", data: { requestId } }]);
    // The first attempt and the one retry that retryLimit 1 allows.
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(1);
    expect(await jobsIn(alwaysFails.queue)).toEqual([{ state: "failed", data: { requestId } }]);
  });
});

describe("upgrading the job queue's schema", () => {
  let upgraded: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    upgraded = await createTestDatabase();
    client = new pg.Client({ connectionString: upgraded.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await upgraded.drop();
  });

  it("brings an older schema up to this release's version, index builds included", async () => {
    await installJobQueue(client, () => {});
    // An install from an older pg-boss, many versions back, with index builds among its migrations.
    for (let version = JOB_QUEUE_VERSION; version > 30; version--) await client.query(getRollbackPlans("pgboss", version));
    expect((await client.query("SELECT version FROM pgboss.version")).rows).toEqual([{ version: 30 }]);
    const lines: string[] = [];
    await installJobQueue(client, (line) => lines.push(line));
    expect(lines).toEqual([`migrate: upgraded the job queue's schema from version 30 to ${JOB_QUEUE_VERSION}`]);
    expect((await client.query("SELECT version FROM pgboss.version")).rows).toEqual([{ version: JOB_QUEUE_VERSION }]);
    const invalid = await client.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss' AND NOT i.indisvalid`,
    );
    expect(invalid.rows).toEqual([]);
  });

  it("refuses a schema that a later release installed, so the older image does not start", async () => {
    await client.query(`UPDATE pgboss.version SET version = ${JOB_QUEUE_VERSION + 1}`);
    try {
      await expect(installJobQueue(client, () => {})).rejects.toThrow(
        `The job queue's schema is at version ${JOB_QUEUE_VERSION + 1}, which a later release installed; this ` +
          `image's job queue needs version ${JOB_QUEUE_VERSION}, so this image is older than the database's schema. ` +
          "To go back to it, restore the backup taken before the upgrade.",
      );
    } finally {
      await client.query(`UPDATE pgboss.version SET version = ${JOB_QUEUE_VERSION}`);
    }
  });
});
