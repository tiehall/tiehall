import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineEventType, EventShapeError, messagePosted, type Provenance } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  migrate,
  openDatabase,
  write,
  WriteWithoutEventError,
  type Database,
  type JobSender,
  type JobType,
  type Store,
} from "../src/index.ts";

// The single write path (requests: The event log; activity-log: Which actions
// are security events; design.md, Technical decisions: T5). A command's change,
// the domain or security event that records it and any job it starts commit in
// one transaction, or none of them does: an event exists if and only if its
// change committed, and a job never runs for a change that did not. The event
// takes the caller's provenance, which the server stamped, never the handler's.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const BOB = randomUUID();
const PIA = randomUUID();
const LEE = randomUUID();

/** A security event of the kind task 9 adds, declared here for the test. */
const roleChanged = defineEventType({
  type: "member.role_changed",
  class: "security",
  fields: { userId: { kind: "id", of: "user" }, role: { kind: "enum", values: ["admin", "member"] } },
});

/** A job of the kind the mirrors start, sent through the probe queue below. */
const mirrorRequest: JobType<{ requestId: string }> = { queue: "probe.mirror_request.v1" };

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let store: Store;
const sent: string[] = [];
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

/** A queue that keeps its jobs in a table, inside the caller's transaction, as pg-boss's send() will in 4.11. */
const probeQueue: JobSender = {
  async send(tx, queue, data) {
    sent.push(queue);
    await tx.execute(`INSERT INTO probe_jobs (queue, data) VALUES (${pg.escapeLiteral(queue)}, ${pg.escapeLiteral(JSON.stringify(data))})`);
  },
};

const agent: Provenance = { actorKind: "agent", userId: BOB, surface: "cli", client: "tiehall/0.1.0" };
const webSession: Provenance = { actorKind: "web_session", userId: PIA, surface: "web" };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  // The changes and the queue that later tasks add, reduced to what this test needs. A message may not be
  // "commit-time failure", which a deferred check only finds when the transaction commits.
  await owner.query(
    `CREATE TABLE probe_messages (
       org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), request_id uuid NOT NULL, body text NOT NULL,
       PRIMARY KEY (org_id, id));
     CREATE FUNCTION probe_refuse_marked() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.body = 'commit-time failure' THEN RAISE EXCEPTION 'refused at commit'; END IF; RETURN NULL; END $$;
     CREATE CONSTRAINT TRIGGER probe_messages_checked_at_commit AFTER INSERT ON probe_messages
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_refuse_marked();
     CREATE TABLE probe_members (org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, PRIMARY KEY (org_id, user_id));
     CREATE TABLE probe_jobs (id bigserial PRIMARY KEY, queue text NOT NULL, data jsonb NOT NULL);`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  store = { database: db, jobs: probeQueue };
  const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id;
  await owner.query("INSERT INTO probe_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, LEE]);
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  sent.length = 0;
  // Events are append-only; the test container's superuser clears them with triggers off for its own transaction.
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM probe_messages; DELETE FROM probe_jobs; DELETE FROM events; DELETE FROM event_sequence;
     UPDATE probe_members SET role = 'member'; COMMIT`,
  );
});

/** Posts a message, records its event and starts the mirror job, as the handler of post_message will. */
function postMessage(requestId: string, body: string, after: () => Promise<void> = async () => {}) {
  return write(store, agent, async (writer) => {
    const { rows } = await writer.tx.execute<{ id: string }>(
      `INSERT INTO probe_messages (org_id, request_id, body) VALUES ('${writer.orgId}', '${requestId}', ${pg.escapeLiteral(body)})
       RETURNING id`,
    );
    const messageId = rows[0]?.id ?? "";
    const event = await writer.record(messagePosted, { requestId, messageId });
    await writer.enqueue(mirrorRequest, { requestId });
    await after();
    return { messageId, event };
  });
}

/** Changes Lee's role and records the security event, as the confirmed role change will. */
function changeLeesRole(role: "admin" | "member", after: () => Promise<void> = async () => {}) {
  return write(store, webSession, async (writer) => {
    await writer.tx.execute(`UPDATE probe_members SET role = '${role}' WHERE org_id = '${writer.orgId}' AND user_id = '${LEE}'`);
    await writer.record(roleChanged, { userId: LEE, role });
    await after();
  });
}

async function counts(): Promise<{ messages: number; events: number; jobs: number }> {
  const { rows } = await owner.query<{ messages: number; events: number; jobs: number }>(
    `SELECT (SELECT count(*)::int FROM probe_messages) AS messages, (SELECT count(*)::int FROM events) AS events,
            (SELECT count(*)::int FROM probe_jobs) AS jobs`,
  );
  return rows[0] ?? { messages: -1, events: -1, jobs: -1 };
}

async function leesRoleAndItsEvents(): Promise<{ role: string | undefined; events: unknown[] }> {
  const role = (await owner.query<{ role: string }>("SELECT role FROM probe_members WHERE user_id = $1", [LEE])).rows[0]?.role;
  const { rows } = await owner.query(
    `SELECT class, type, data, actor_kind, actor_user_id, surface FROM events WHERE type = 'member.role_changed' ORDER BY number`,
  );
  return { role, events: rows };
}

describe("a write", () => {
  it("commits the change, its event and its job together", async () => {
    const requestId = randomUUID();
    const { messageId, event } = await postMessage(requestId, "Which endpoint?");
    expect(event).toEqual({ number: 1 });
    expect(await counts()).toEqual({ messages: 1, events: 1, jobs: 1 });
    const { rows } = await owner.query(
      "SELECT e.number, e.class, e.type, e.data, e.actor_kind, e.actor_user_id, e.surface, e.client FROM events e",
    );
    expect(rows).toEqual([
      {
        number: "1",
        class: "domain",
        type: "request.message_posted",
        data: { requestId, messageId },
        actor_kind: "agent",
        actor_user_id: BOB,
        surface: "cli",
        client: "tiehall/0.1.0",
      },
    ]);
    expect((await owner.query("SELECT queue, data FROM probe_jobs")).rows).toEqual([
      { queue: "probe.mirror_request.v1", data: { requestId } },
    ]);
  });

  it("leaves no change, no event and no job when it fails after its event is prepared", async () => {
    const failure = new Error("the handler failed after recording its event and starting its job");
    await expect(
      postMessage(randomUUID(), "Which endpoint?", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(sent).toEqual(["probe.mirror_request.v1"]);
    expect(await counts()).toEqual({ messages: 0, events: 0, jobs: 0 });
  });

  it("leaves no change, no event and no job when the transaction fails as it commits", async () => {
    // The driver reports the failed COMMIT, with Postgres's refusal as its cause.
    const failure = await postMessage(randomUUID(), "commit-time failure").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ message: "refused at commit" });
    expect(sent).toEqual(["probe.mirror_request.v1"]);
    expect(await counts()).toEqual({ messages: 0, events: 0, jobs: 0 });
  });

  it("leaves no change and no job when its event is refused", async () => {
    await expect(
      write(store, agent, async (writer) => {
        await writer.tx.execute(
          `INSERT INTO probe_messages (org_id, request_id, body) VALUES ('${writer.orgId}', '${randomUUID()}', 'Which endpoint?')`,
        );
        await writer.enqueue(mirrorRequest, { requestId: randomUUID() });
        await writer.record(messagePosted, { requestId: randomUUID(), messageId: "not-an-id" });
      }),
    ).rejects.toThrow(EventShapeError);
    expect(await counts()).toEqual({ messages: 0, events: 0, jobs: 0 });
  });

  it("is refused, and leaves nothing, when it records no event", async () => {
    await expect(
      write(store, agent, async (writer) => {
        await writer.tx.execute(
          `INSERT INTO probe_messages (org_id, request_id, body) VALUES ('${writer.orgId}', '${randomUUID()}', 'unrecorded')`,
        );
        await writer.enqueue(mirrorRequest, { requestId: randomUUID() });
      }),
    ).rejects.toThrow(new WriteWithoutEventError());
    expect(await counts()).toEqual({ messages: 0, events: 0, jobs: 0 });
  });

  it("gives every event the caller's provenance", async () => {
    await write(store, { actorKind: "system", surface: "github" }, async (writer) => {
      await writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() });
      await writer.record(messagePosted, { requestId: randomUUID(), messageId: randomUUID() });
    });
    const { rows } = await owner.query("SELECT number, actor_kind, actor_user_id, surface FROM events ORDER BY number");
    expect(rows).toEqual([
      { number: "1", actor_kind: "system", actor_user_id: null, surface: "github" },
      { number: "2", actor_kind: "system", actor_user_id: null, surface: "github" },
    ]);
  });
});

describe("a security event and its change", () => {
  it("are both present when the write commits", async () => {
    await changeLeesRole("admin");
    expect(await leesRoleAndItsEvents()).toEqual({
      role: "admin",
      events: [
        {
          class: "security",
          type: "member.role_changed",
          data: { userId: LEE, role: "admin" },
          actor_kind: "web_session",
          actor_user_id: PIA,
          surface: "web",
        },
      ],
    });
  });

  it("are both absent when the write fails", async () => {
    await expect(
      changeLeesRole("admin", async () => {
        throw new Error("the removal failed");
      }),
    ).rejects.toThrow("the removal failed");
    expect(await leesRoleAndItsEvents()).toEqual({ role: "member", events: [] });

    // The failed write gave its event number back: the next write that commits takes it.
    await changeLeesRole("admin");
    const { rows } = await owner.query("SELECT number FROM events");
    expect(rows).toEqual([{ number: "1" }]);
  });
});
