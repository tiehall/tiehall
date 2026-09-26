import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { EVENT_TABLES } from "../src/database-roles.ts";
import { migrate } from "../src/migrate.ts";

// The activity log is append-only (activity-log: The activity log is
// append-only; design.md, Self-hosting decisions: S14). A trigger on every
// event table refuses each update and delete of an event, whoever tries, and
// the app role holds only insert and select on those tables. The app role owns
// neither the tables nor the trigger's function, so it can neither drop nor
// disable the trigger. Only whoever holds the owner role or the host can get
// around it, which the documentation states.

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const REFUSED = /Events are append-only: (UPDATE|DELETE|TRUNCATE) of public\.events is refused\./;

let database: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

/** The error a statement fails with, or undefined when it succeeds. */
async function failureOf(client: pg.Client, sql: string): Promise<string | undefined> {
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function theEvent(): Promise<unknown[]> {
  return (await owner.query("SELECT number, type, data FROM events ORDER BY number")).rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = encodeURIComponent(appRole.password);
  app = new pg.Client({ connectionString: url.toString() });
  await app.connect();
  const orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id;
  // The app role appends, as the write path does.
  await app.query(
    `INSERT INTO events (org_id, number, class, type, data, actor_kind) VALUES ($1, 1, 'domain', 'request.opened', '{}', 'system')`,
    [orgId],
  );
});

afterAll(async () => {
  await app.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("the event tables", () => {
  it("are the tables that carry the append-only triggers", async () => {
    expect(EVENT_TABLES).toEqual(["public.events"]);
    const { rows } = await owner.query<{ table: string; trigger: string; enabled: string }>(
      `SELECT t.tgrelid::regclass::text AS table, t.tgname AS trigger, t.tgenabled AS enabled
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'tiehall_refuse_event_change' AND NOT t.tgisinternal
        ORDER BY 1, 2`,
    );
    // Enabled ('O'), on each event table, for updates and deletes and for truncation.
    expect(rows).toEqual(
      EVENT_TABLES.flatMap((table) => [
        { table: table.replace(/^public\./, ""), trigger: "events_refuse_truncate", enabled: "O" },
        { table: table.replace(/^public\./, ""), trigger: "events_refuse_update_delete", enabled: "O" },
      ]),
    );
  });

  it("refuse every update and delete of an event, even from the owner", async () => {
    expect(await failureOf(owner, "UPDATE events SET type = 'request.rewritten'")).toMatch(REFUSED);
    expect(await failureOf(owner, "DELETE FROM events")).toMatch(REFUSED);
    expect(await failureOf(owner, "TRUNCATE events")).toMatch(REFUSED);
    expect(await theEvent()).toEqual([{ number: "1", type: "request.opened", data: {} }]);
  });
});

describe("the app role", () => {
  it("holds only insert and select on the event tables", async () => {
    for (const table of EVENT_TABLES) {
      const { rows } = await app.query(
        `SELECT privilege, has_table_privilege(current_user, $1, privilege) AS held
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege`,
        [table],
      );
      expect(rows, table).toEqual([
        { privilege: "SELECT", held: true },
        { privilege: "INSERT", held: true },
        { privilege: "UPDATE", held: false },
        { privilege: "DELETE", held: false },
        { privilege: "TRUNCATE", held: false },
        { privilege: "REFERENCES", held: false },
        { privilege: "TRIGGER", held: false },
      ]);
    }
  });

  it("cannot update or delete an event", async () => {
    expect(await failureOf(app, "UPDATE events SET type = 'request.rewritten'")).toMatch(/permission denied for table events/);
    expect(await failureOf(app, "DELETE FROM events")).toMatch(/permission denied for table events/);
    expect(await failureOf(app, "TRUNCATE events")).toMatch(/permission denied for table events/);
    expect(await theEvent()).toEqual([{ number: "1", type: "request.opened", data: {} }]);
  });

  it("cannot drop, disable or replace the trigger, or switch triggers off for its session", async () => {
    const attempts = {
      "drop the trigger": "DROP TRIGGER events_refuse_update_delete ON events",
      "disable the trigger": "ALTER TABLE events DISABLE TRIGGER events_refuse_update_delete",
      "disable every trigger": "ALTER TABLE events DISABLE TRIGGER ALL",
      "drop the function": "DROP FUNCTION tiehall_refuse_event_change() CASCADE",
      "replace the function":
        "CREATE OR REPLACE FUNCTION tiehall_refuse_event_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
      "rename the function": "ALTER FUNCTION tiehall_refuse_event_change() RENAME TO tiehall_harmless",
      "add its own trigger": "CREATE TRIGGER events_let_through BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()",
      "skip triggers as a replica": "SET session_replication_role = replica",
    };
    const results = Object.fromEntries(
      await Promise.all(Object.entries(attempts).map(async ([what, sql]) => [what, await failureOf(app, sql)] as const)),
    );
    expect(results).toEqual({
      "drop the trigger": expect.stringMatching(/must be owner of (table|relation) events/),
      "disable the trigger": expect.stringMatching(/must be owner of (table|relation) events/),
      "disable every trigger": expect.stringMatching(/must be owner of (table|relation) events/),
      "drop the function": expect.stringMatching(/must be owner of function tiehall_refuse_event_change/),
      "replace the function": expect.stringMatching(/must be owner of function tiehall_refuse_event_change|permission denied/),
      "rename the function": expect.stringMatching(/must be owner of function tiehall_refuse_event_change/),
      "add its own trigger": expect.stringMatching(/permission denied for table events/),
      "skip triggers as a replica": expect.stringMatching(/permission denied to set parameter "session_replication_role"/),
    });

    const { rows } = await owner.query(
      "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'events'::regclass AND NOT tgisinternal ORDER BY tgname",
    );
    expect(rows).toEqual([
      { tgname: "events_refuse_truncate", tgenabled: "O" },
      { tgname: "events_refuse_update_delete", tgenabled: "O" },
    ]);
    expect(await failureOf(owner, "UPDATE events SET type = 'request.rewritten'")).toMatch(REFUSED);
    expect(await theEvent()).toEqual([{ number: "1", type: "request.opened", data: {} }]);
  });
});
