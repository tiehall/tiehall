import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand } from "@tiehall/catalog";
import { messagePosted, PROBLEM_TYPE_BASE, Refusal } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  createExecute,
  createLogger,
  createRestHandler,
  IDEMPOTENCY_KEY_HOURS,
  migrate,
  openDatabase,
  pruneIdempotencyKeys,
  startWorker,
  WORKER_JOBS,
  type Caller,
  type Database,
  type DatabaseConnection,
  type Handler,
  type RestHandler,
} from "../src/index.ts";

// Idempotency-Key on every POST (public-api: POST operations take an
// Idempotency-Key; design.md, Decisions this change rests on: D28 #20),
// following draft-ietf-httpapi-idempotency-key-header. The header is optional.
// A key is kept per caller for 24 hours, with a digest of the first call's
// body and the response it got, in the call's own transaction: a repeat with
// the same body gets that response without running again; a reused key with a
// different body gets 422; the same key from another caller is another key.
// An hourly job purges the keys older than 24 hours.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const INSTALL = "https://tiehall.example.com";
const HOUR = 60 * 60 * 1000;

const catalog = defineCatalog([
  defineCommand({
    id: "probes.create",
    summary: "Open a probe request.",
    input: z.object({ title: z.string() }),
    output: z.object({ id: z.uuid(), title: z.string() }),
    method: "POST",
    path: "/api/v1/probes",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest"],
    stability: "alpha",
  }),
]);

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let app: DatabaseConnection;
let rest: RestHandler;
/** The clock the route reads. */
let now = new Date("2026-10-01T09:00:00Z");
/** Runs inside the handler before it answers, so a test can hold a call open. */
let during: () => Promise<void> = async () => {};
/** When set, the handler refuses after writing, so the call is rolled back. */
let refuse = false;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

const alice: Caller = { kind: "personal_access_token", userId: randomUUID(), tokenId: randomUUID(), scopes: ["requests:write"], surface: "cli" };
const bob: Caller = {
  kind: "oauth_token",
  userId: randomUUID(),
  clientId: "https://client.example/metadata.json",
  scopes: ["requests:write"],
  surface: "api",
};

const createProbe: Handler = async (input, context) => {
  const { title } = input as { title: string };
  const created = await context.write(async (writer) => {
    const { rows } = await writer.tx.execute<{ id: string }>(
      `INSERT INTO probe_requests (org_id, title) VALUES ('${writer.orgId}', ${pg.escapeLiteral(title)}) RETURNING id`,
    );
    const id = rows[0]?.id ?? "";
    await writer.record(messagePosted, { requestId: id, messageId: id });
    return { id, title };
  });
  await during();
  if (refuse) throw new Refusal("conflict", "The probe refuses this call after writing.");
  return created;
};

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await owner.query(
    `CREATE TABLE probe_requests (
       org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), title text NOT NULL, PRIMARY KEY (org_id, id))`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  app = { connectionString: url.toString(), password: appRole.password };
  db = openDatabase(app);
  const execute = createExecute({
    catalog,
    handlers: { "probes.create": createProbe },
    store: { database: db, jobs: { send: async () => {} } },
  });
  rest = createRestHandler({
    catalog,
    document: "{}\n",
    execute,
    // The test names its caller in a header of its own.
    authenticate: async (request) => (request.headers.get("x-test-caller") === "bob" ? bob : alice),
    logger: createLogger({ write: () => {} }),
    now: () => now,
  });
  await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  now = new Date("2026-10-01T09:00:00Z");
  during = async () => {};
  refuse = false;
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM idempotency_keys; DELETE FROM probe_requests; DELETE FROM events; DELETE FROM event_sequence; COMMIT`,
  );
});

async function create(body: unknown, headers: Record<string, string> = {}) {
  const response = await rest(
    new Request(`${INSTALL}/api/v1/probes`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    }),
  );
  return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
}

async function probes(): Promise<number> {
  return (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM probe_requests")).rows[0]?.count ?? -1;
}

describe("a POST with an Idempotency-Key", () => {
  it("runs once: a repeat gets the first call's status and body without running again", async () => {
    const first = await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": '"first-call"' });
    expect(first.status).toBe(200);
    const second = await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": '"first-call"' });
    expect(second).toEqual(first);
    expect(await probes()).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS count FROM events")).rows[0]).toEqual({ count: 1 });
  });

  it("accepts the key with or without the quotes of a structured string", async () => {
    const first = await create({ title: "Retry after a timeout" }, { "idempotency-key": '"retry-1"' });
    const second = await create({ title: "Retry after a timeout" }, { "idempotency-key": "retry-1" });
    expect(second).toEqual(first);
    expect(await probes()).toBe(1);
  });

  it("refuses a reused key with a different body with 422, and does not run", async () => {
    await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "reused" });
    now = new Date(now.getTime() + HOUR);
    const reused = await create({ title: "Something else" }, { "idempotency-key": "reused" });
    expect(reused.status).toBe(422);
    expect(reused.type).toBe("application/problem+json");
    expect(JSON.parse(reused.body)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}idempotency-key-reused`, status: 422 });
    expect(await probes()).toBe(1);
  });

  it("keeps keys per caller: the same key from two callers runs twice", async () => {
    await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "shared" });
    const other = await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "shared", "x-test-caller": "bob" });
    expect(other.status).toBe(200);
    expect(await probes()).toBe(2);
  });

  it("keeps a key for 24 hours: a repeat 23 hours later runs nothing, one 25 hours later runs again", async () => {
    const first = await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "day" });
    now = new Date(now.getTime() + 23 * HOUR);
    expect(await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "day" })).toEqual(first);
    expect(await probes()).toBe(1);
    now = new Date(now.getTime() + 2 * HOUR);
    const later = await create({ title: "Add a /v2/orders endpoint" }, { "idempotency-key": "day" });
    expect(later.status).toBe(200);
    expect(later.body).not.toBe(first.body);
    expect(await probes()).toBe(2);
  });

  it("keeps no key for a call that fails, so its retry runs", async () => {
    refuse = true;
    expect((await create({ title: "Refused" }, { "idempotency-key": "failed" })).status).toBe(409);
    refuse = false;
    expect((await create({ title: "Refused" }, { "idempotency-key": "failed" })).status).toBe(200);
    expect(await probes()).toBe(1);
  });

  it("runs once when the repeat arrives while the first call is still running", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    during = async () => {
      running++;
      await held;
    };
    const first = create({ title: "Held open" }, { "idempotency-key": "concurrent" });
    await expect.poll(() => running).toBe(1);
    const second = create({ title: "Held open" }, { "idempotency-key": "concurrent" });
    // The repeat waits for the first call's transaction, so it cannot run beside it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running).toBe(1);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
    expect(running).toBe(1);
    expect(await probes()).toBe(1);
  });

  it("refuses a key that is not a short visible string with 400", async () => {
    for (const key of ["", '""', "x".repeat(256), "tab\there"]) {
      const response = await create({ title: "Bad key" }, { "idempotency-key": key });
      expect(response.status, JSON.stringify(key)).toBe(400);
    }
    expect(await probes()).toBe(0);
  });
});

describe("a POST without an Idempotency-Key", () => {
  it("runs every time", async () => {
    await create({ title: "Add a /v2/orders endpoint" });
    await create({ title: "Add a /v2/orders endpoint" });
    expect(await probes()).toBe(2);
  });
});

describe("the hourly purge", () => {
  it("deletes the keys older than 24 hours and keeps the others", async () => {
    await create({ title: "Old" }, { "idempotency-key": "old" });
    now = new Date(now.getTime() + 2 * HOUR);
    await create({ title: "Recent" }, { "idempotency-key": "recent" });
    const signal = new AbortController().signal;
    await pruneIdempotencyKeys.handle(
      { id: randomUUID(), queue: pruneIdempotencyKeys.type.queue, data: {}, signal },
      { database: db, now: () => new Date(now.getTime() + (IDEMPOTENCY_KEY_HOURS - 1) * HOUR) },
    );
    expect((await owner.query("SELECT key FROM idempotency_keys ORDER BY key")).rows).toEqual([{ key: "recent" }]);
  });

  it("is scheduled every hour by the worker role", async () => {
    expect(WORKER_JOBS).toContain(pruneIdempotencyKeys);
    const worker = await startWorker({ connection: app, jobs: WORKER_JOBS, logger: createLogger({ write: () => {} }) });
    try {
      const { rows } = await owner.query("SELECT cron, timezone FROM pgboss.schedule WHERE name = $1", [pruneIdempotencyKeys.type.queue]);
      expect(rows).toEqual([{ cron: expect.stringMatching(/^\d+ \* \* \* \*$/), timezone: "UTC" }]);
    } finally {
      await worker.stop();
    }
  });
});
