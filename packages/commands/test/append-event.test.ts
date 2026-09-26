import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EventShapeError, messagePosted } from "@tiehall/core";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { appendEvent, migrate, openDatabase, withOrg, type Database } from "../src/index.ts";

// The event shape in the database (requests: Events carry ids, not bodies;
// activity-log: The activity log holds domain events and security events).
// appendEvent() writes one event inside the handler's transaction, as the app
// role: the next sequence number, the time, the class and type, the ids its
// type declares, and who caused it. An event for a message holds the message's
// id; its text stays in the message.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const QUESTION = `Which endpoint does the export use? canary-${randomBytes(8).toString("hex")}`;
const BOB = randomUUID();
const FE = randomUUID();

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let orgId: string;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  // The thread messages a later task adds, reduced to what this test needs.
  await owner.query(
    `CREATE TABLE probe_messages (
       org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), request_id uuid NOT NULL, body text NOT NULL,
       PRIMARY KEY (org_id, id))`,
  );
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id ?? "";
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

afterEach(async () => {
  // Events are append-only, whoever tries (activity-log: The activity log is append-only). The test container's
  // superuser clears them by switching triggers off for its own transaction, which only the host's holder can do.
  await owner.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     DELETE FROM probe_messages; DELETE FROM events; DELETE FROM event_sequence; COMMIT`,
  );
});

/** Posts a message and appends its event in one transaction, as the handler of post_message will. */
async function postMessage(requestId: string, body: string, extra: Record<string, unknown> = {}) {
  return withOrg(db, async (context) => {
    const [message] = (
      await context.tx.execute<{ id: string }>(
        `INSERT INTO probe_messages (org_id, request_id, body) VALUES ('${context.orgId}', '${requestId}', ${pg.escapeLiteral(body)})
         RETURNING id`,
      )
    ).rows;
    const messageId = message?.id ?? "";
    const event = await appendEvent(
      context,
      messagePosted,
      { requestId, messageId, ...extra },
      { actorKind: "agent", userId: BOB, surface: "mcp", client: "https://client.example/tiehall.json", teamId: FE },
    );
    return { messageId, event };
  });
}

async function storedEvents(): Promise<Record<string, unknown>[]> {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    "SELECT to_jsonb(e) AS event FROM events e ORDER BY number",
  );
  return rows.map(({ event }) => event);
}

describe("an event for a message", () => {
  it("holds the request and message ids, its class, type, time and provenance, and not the message's text", async () => {
    const requestId = randomUUID();
    const before = new Date();
    const { messageId, event } = await postMessage(requestId, QUESTION);
    expect(event).toEqual({ number: 1 });

    const [stored, ...others] = await storedEvents();
    expect(others).toEqual([]);
    expect(stored).toEqual({
      org_id: orgId,
      number: 1,
      occurred_at: expect.any(String),
      class: "domain",
      type: "request.message_posted",
      data: { requestId, messageId },
      actor_kind: "agent",
      actor_user_id: BOB,
      client: "https://client.example/tiehall.json",
      surface: "mcp",
      team_id: FE,
      operator_command: null,
    });
    expect(new Date(String(stored?.["occurred_at"])).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(JSON.stringify(stored)).not.toContain(QUESTION);
    expect(JSON.stringify(stored)).not.toContain("canary");
  });

  it("is refused, with the message, when it would carry the message's text", async () => {
    await expect(postMessage(randomUUID(), QUESTION, { text: QUESTION })).rejects.toThrow(
      new EventShapeError('request.message_posted has no field "text"; an event carries only the fields its type declares.'),
    );
    expect(await storedEvents()).toEqual([]);
    expect((await owner.query("SELECT count(*)::int AS messages FROM probe_messages")).rows).toEqual([{ messages: 0 }]);
  });

  it("takes the next number of the install's sequence", async () => {
    const requestId = randomUUID();
    await postMessage(requestId, "first");
    await postMessage(requestId, "second");
    expect((await storedEvents()).map((event) => event["number"])).toEqual([1, 2]);
  });
});

describe("who caused an event", () => {
  it("records an operator command by the command and no user", async () => {
    const requestId = randomUUID();
    const messageId = randomUUID();
    await withOrg(db, (context) =>
      appendEvent(context, messagePosted, { requestId, messageId }, { actorKind: "operator", command: "setup reopen" }),
    );
    const [stored] = await storedEvents();
    expect(stored).toMatchObject({
      actor_kind: "operator",
      operator_command: "setup reopen",
      actor_user_id: null,
      client: null,
      surface: null,
      team_id: null,
    });
  });

  it("refuses the actor kind human, and stores nothing", async () => {
    await expect(
      withOrg(db, (context) =>
        appendEvent(
          context,
          messagePosted,
          { requestId: randomUUID(), messageId: randomUUID() },
          { actorKind: "human", userId: BOB, surface: "web" } as never,
        ),
      ),
    ).rejects.toThrow(
      new EventShapeError(
        "The actor kind human is reserved for a later confirmation that proves a person acted; v1 never records it.",
      ),
    );
    expect(await storedEvents()).toEqual([]);
  });
});

describe("the events table", () => {
  it("refuses, even from the owner, a class, an actor kind or a surface outside the event shape", async () => {
    const insert = (values: string) =>
      owner.query(
        `INSERT INTO events (org_id, number, class, type, data, actor_kind, actor_user_id, surface, operator_command)
         VALUES ('${orgId}', 1, ${values})`,
      );
    await expect(insert(`'audit', 'x.y', '{}', 'system', NULL, NULL, NULL`)).rejects.toThrow(/events_class_known/);
    await expect(insert(`'domain', 'x.y', '{}', 'human', '${BOB}', 'web', NULL`)).rejects.toThrow(/events_actor_kind_known/);
    await expect(insert(`'domain', 'x.y', '{}', 'agent', '${BOB}', 'slack', NULL`)).rejects.toThrow(/events_surface_known/);
    await expect(insert(`'domain', 'x.y', '"text"', 'system', NULL, NULL, NULL`)).rejects.toThrow(/events_data_is_object/);
    await expect(insert(`'domain', 'x.y', '{}', 'agent', NULL, 'mcp', NULL`)).rejects.toThrow(/events_actor_names_user/);
    await expect(insert(`'domain', 'x.y', '{}', 'operator', '${BOB}', NULL, 'admin grant'`)).rejects.toThrow(
      /events_operator_names_command/,
    );
    await expect(insert(`'domain', 'x.y', '{}', 'system', NULL, NULL, 'admin grant'`)).rejects.toThrow(
      /events_operator_names_command/,
    );
    expect(await storedEvents()).toEqual([]);
  });
});
