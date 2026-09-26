import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineEventType, messagePosted, type Provenance } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createLogger,
  migrate,
  openDatabase,
  openJobQueue,
  pruneSecurityEventOrigins,
  startWorker,
  WORKER_JOBS,
  write,
  type Database,
  type DatabaseConnection,
  type JobQueue,
} from "../src/index.ts";

// IP addresses and user agents are kept apart for 90 days (activity-log: IP
// addresses and user agents are kept apart for 90 days; design.md, Self-hosting
// decisions: S14). The write path records the caller's IP address and user
// agent for a security event in a side table, never in the event; a daily job
// deletes them 90 days after their event, and the event stays. The job reads
// the time from the worker's clock, which the tests control.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const silent = createLogger({ write: () => {} });
const DAY = 24 * 60 * 60 * 1000;
const ALICE = randomUUID();
const USER_AGENT = `Mozilla/5.0 (canary ${randomBytes(6).toString("hex")})`;

/** A security event of the kind task 15 adds when a personal access token is created. */
const tokenCreated = defineEventType({
  type: "token.created",
  class: "security",
  fields: { tokenId: { kind: "id", of: "token" } },
});

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let app: DatabaseConnection;
let queue: JobQueue;
const alice: Provenance = { actorKind: "web_session", userId: ALICE, surface: "web" };
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
  queue = await openJobQueue({ connection: app, jobTypes: [pruneSecurityEventOrigins.type], logger: silent });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await queue.stop();
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM security_event_origins; DELETE FROM events; DELETE FROM event_sequence; DELETE FROM pgboss.job;
     COMMIT`,
  );
});

/** Alice creates a personal access token from 203.0.113.7; returns the event's number and time. */
async function createToken(): Promise<{ number: number; occurredAt: Date }> {
  const { number } = await write(
    { database: db, jobs: queue },
    alice,
    (writer) => writer.record(tokenCreated, { tokenId: randomUUID() }),
    { origin: { ipAddress: "203.0.113.7", userAgent: USER_AGENT } },
  );
  const { rows } = await owner.query<{ occurred_at: Date }>("SELECT occurred_at FROM events WHERE number = $1", [number]);
  return { number, occurredAt: rows[0]?.occurred_at ?? new Date(Number.NaN) };
}

async function origins(): Promise<{ event_number: string; ip_address: string; user_agent: string }[]> {
  return (
    await owner.query<{ event_number: string; ip_address: string; user_agent: string }>(
      "SELECT event_number, host(ip_address) AS ip_address, user_agent FROM security_event_origins ORDER BY event_number",
    )
  ).rows;
}

/** Runs the pruning job once through a worker whose clock reads `now`, as the daily schedule does. */
async function runPruningAt(now: Date): Promise<void> {
  const worker = await startWorker({
    connection: app,
    jobs: [pruneSecurityEventOrigins],
    clock: () => now,
    pollingIntervalSeconds: 0.5,
    logger: silent,
  });
  try {
    const id = await queue.boss.send(pruneSecurityEventOrigins.type.queue, {});
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await owner.query<{ state: string }>("SELECT state::text AS state FROM pgboss.job WHERE id = $1", [id]);
      if (rows[0]?.state === "completed") return;
      if (Date.now() > deadline) throw new Error(`The pruning job did not complete: ${rows[0]?.state}`);
      await sleep(100);
    }
  } finally {
    await worker.stop();
  }
}

describe("the side table", () => {
  it("holds the IP address and user agent of a security event, which the event itself does not", async () => {
    const { number } = await createToken();
    expect(await origins()).toEqual([{ event_number: String(number), ip_address: "203.0.113.7", user_agent: USER_AGENT }]);
    const { rows } = await owner.query("SELECT to_jsonb(e)::text AS event FROM events e");
    expect(rows[0]?.event).not.toContain("203.0.113.7");
    expect(rows[0]?.event).not.toContain(USER_AGENT);
  });

  it("holds nothing for a domain event, which has no IP address kept", async () => {
    await write(
      { database: db, jobs: queue },
      alice,
      (writer) => writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() }),
      { origin: { ipAddress: "203.0.113.7", userAgent: USER_AGENT } },
    );
    expect(await origins()).toEqual([]);
  });

  it("commits or rolls back with its event", async () => {
    await expect(
      write(
        { database: db, jobs: queue },
        alice,
        async (writer) => {
          await writer.record(tokenCreated, { tokenId: randomUUID() });
          throw new Error("creating the token failed");
        },
        { origin: { ipAddress: "203.0.113.7", userAgent: USER_AGENT } },
      ),
    ).rejects.toThrow("creating the token failed");
    expect(await origins()).toEqual([]);
  });

  it("refuses a malformed IP address with the write", async () => {
    await expect(
      write(
        { database: db, jobs: queue },
        alice,
        (writer) => writer.record(tokenCreated, { tokenId: randomUUID() }),
        { origin: { ipAddress: "not-an-address", userAgent: USER_AGENT } },
      ),
    ).rejects.toThrow();
    expect((await owner.query("SELECT count(*)::int AS events FROM events")).rows).toEqual([{ events: 0 }]);
  });
});

describe("the daily pruning job", () => {
  it("deletes the IP address and user agent 91 days after their event, and the event stays", async () => {
    const { number, occurredAt } = await createToken();
    await runPruningAt(new Date(occurredAt.getTime() + 91 * DAY));
    expect(await origins()).toEqual([]);
    expect((await owner.query("SELECT number, type FROM events")).rows).toEqual([{ number: String(number), type: "token.created" }]);
  });

  it("keeps them 89 days after their event", async () => {
    const { number, occurredAt } = await createToken();
    await runPruningAt(new Date(occurredAt.getTime() + 89 * DAY));
    expect(await origins()).toEqual([{ event_number: String(number), ip_address: "203.0.113.7", user_agent: USER_AGENT }]);
  });

  it("deletes only the rows past 90 days when older and newer ones are side by side", async () => {
    const recent = await createToken();
    // A security event recorded 30 days before the recent one, with its IP address and user agent.
    await owner.query(
      `WITH earlier AS (
         INSERT INTO events (org_id, number, occurred_at, class, type, data, actor_kind, actor_user_id, surface)
         SELECT id, 1000, $1::timestamptz - interval '30 days', 'security', 'token.created', '{}', 'web_session', $2, 'web'
           FROM orgs RETURNING org_id, number)
       INSERT INTO security_event_origins (org_id, event_number, ip_address, user_agent)
       SELECT org_id, number, '198.51.100.23', 'curl/8.9' FROM earlier`,
      [recent.occurredAt, ALICE],
    );
    await runPruningAt(new Date(recent.occurredAt.getTime() + 61 * DAY));
    expect((await origins()).map(({ event_number }) => Number(event_number))).toEqual([recent.number]);
    expect((await owner.query("SELECT count(*)::int AS events FROM events")).rows).toEqual([{ events: 2 }]);
  });

  it("is scheduled every day by the worker role", async () => {
    expect(WORKER_JOBS).toContain(pruneSecurityEventOrigins);
    const worker = await startWorker({ connection: app, jobs: WORKER_JOBS, logger: silent });
    try {
      const { rows } = await owner.query("SELECT name, cron, timezone FROM pgboss.schedule WHERE name = $1", [
        pruneSecurityEventOrigins.type.queue,
      ]);
      expect(rows).toEqual([{ name: pruneSecurityEventOrigins.type.queue, cron: "30 3 * * *", timezone: "UTC" }]);
    } finally {
      await worker.stop();
    }
  });
});
