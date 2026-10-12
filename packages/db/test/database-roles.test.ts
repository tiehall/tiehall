import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  APPEND_ONLY_TABLES,
  EVENT_TABLES,
  IMAGE_SEQUENCES,
  IMAGE_TABLES,
  READ_ONLY_TABLES,
  scramSha256Secret,
  setUpAppRole,
  type AppRole,
  type AppRoleGrants,
} from "../src/database-roles.ts";
import { migrate } from "../src/migrate.ts";

// The database roles (self-host-install: Only the migrate step holds the
// database owner's credentials; design.md, Technical decisions: T4). The
// migrate step connects as the owner and creates or updates the app role, which
// gets data changes on the app's tables but only insert and select on the event
// tables. The test Postgres is the stock postgres:17 image with a password set,
// as the bundled one in deploy/compose.yaml is.

/** Roles belong to the whole container, which other test files share: each name is unique. */
function uniqueRole(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function userUrl(databaseUrl: string, user: string, password?: string): string {
  const url = new URL(databaseUrl);
  url.username = user;
  url.password = password === undefined ? "" : encodeURIComponent(password);
  return url.toString();
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** Runs the queries on a new connection and closes it. */
async function withClient<T>(connectionString: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(connectionString);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** The error a query fails with, or undefined when it succeeds. */
async function failureOf(client: pg.Client, sql: string): Promise<string | undefined> {
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The owner's tables in a fresh database: one the app changes, and the event table it only appends to. */
const FIXTURE_TABLES = `
  CREATE TABLE things (id integer PRIMARY KEY, note text NOT NULL);
  CREATE TABLE events (seq bigint PRIMARY KEY, kind text NOT NULL);
  INSERT INTO things VALUES (1, 'kept');
  INSERT INTO events VALUES (1, 'kept');
`;

/**
 * The rights for the fixture's tables, as an image whose migrations made them would set them: `later` is a
 * table the owner creates in a test below, and `counter` a sequence it creates.
 */
const FIXTURE_GRANTS: AppRoleGrants = {
  schemas: ["public"],
  knownTables: ["public.things", "public.events", "public.later"],
  knownSequences: ["public.counter"],
  appendOnlyTables: ["public.events"],
};

/** The rights the role holds on a table, by the privileges Postgres names. */
async function tableRights(client: pg.Client, role: string, table: string): Promise<string[]> {
  const { rows } = await client.query<{ privilege: string; held: boolean }>(
    `SELECT privilege, has_table_privilege($1, $2::regclass, privilege) AS held
       FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege`,
    [role, table],
  );
  return rows.filter(({ held }) => held).map(({ privilege }) => privilege);
}

/** The rights the role holds on a sequence. */
async function sequenceRights(client: pg.Client, role: string, sequence: string): Promise<string[]> {
  const { rows } = await client.query<{ privilege: string; held: boolean }>(
    `SELECT privilege, has_sequence_privilege($1, $2, privilege) AS held
       FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS privilege`,
    [role, sequence],
  );
  return rows.filter(({ held }) => held).map(({ privilege }) => privilege);
}

describe("setting up the app role", () => {
  let database: TestDatabase;
  let owner: pg.Client;
  let ownerName: string;
  const app: AppRole = { name: uniqueRole("tiehall_app"), password: `app-${randomBytes(12).toString("hex")}` };
  let appClient: pg.Client;

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = await connect(database.url);
    ownerName = decodeURIComponent(new URL(database.url).username);
    await owner.query(FIXTURE_TABLES);
    await setUpAppRole(owner, app, FIXTURE_GRANTS);
    appClient = await connect(userUrl(database.url, app.name, app.password));
  });

  afterAll(async () => {
    await appClient.end();
    await owner.end();
    await database.drop();
    await withClient(inject("postgresUrl"), (admin) => admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(app.name)}`));
  });

  describe("a connection without a password", () => {
    it("fails over the network, for the owner and for the app role", async () => {
      for (const user of [ownerName, app.name]) {
        const client = new pg.Client({ connectionString: userUrl(database.url, user) });
        // The server asks for a SCRAM password before it lets anyone in; with none to give, the client stops.
        await expect(client.connect(), user).rejects.toThrow(/SASL|password/);
        await client.end().catch(() => {});
      }
    });

    it("finds no rule in the server's authentication config that lets another host in without one", async () => {
      // The stock image trusts only loopback, which only processes inside the Postgres container itself can use.
      const { rows } = await owner.query<{ address: string; auth_method: string }>(
        `SELECT address, auth_method FROM pg_hba_file_rules
          WHERE type LIKE 'host%' AND address NOT IN ('127.0.0.1', '::1')`,
      );
      expect(rows).toContainEqual({ address: "all", auth_method: "scram-sha-256" });
      for (const rule of rows) expect(rule.auth_method, JSON.stringify(rule)).toBe("scram-sha-256");
    });
  });

  describe("the app role", () => {
    it("owns no table, and no other object in the database", async () => {
      const { rows } = await appClient.query(
        `SELECT c.relname FROM pg_class c WHERE c.relowner = current_user::regrole
         UNION ALL SELECT n.nspname FROM pg_namespace n WHERE n.nspowner = current_user::regrole`,
      );
      expect(rows).toEqual([]);
    });

    it("cannot alter, drop or truncate a table, or create one it would own", async () => {
      expect(await failureOf(appClient, "ALTER TABLE things ADD COLUMN extra integer")).toMatch(/must be owner of table things/);
      expect(await failureOf(appClient, "ALTER TABLE events DISABLE TRIGGER ALL")).toMatch(/must be owner of table events/);
      expect(await failureOf(appClient, "DROP TABLE things")).toMatch(/must be owner of table things/);
      expect(await failureOf(appClient, "DROP TABLE events")).toMatch(/must be owner of table events/);
      expect(await failureOf(appClient, "TRUNCATE things")).toMatch(/permission denied for table things/);
      expect(await failureOf(appClient, "CREATE TABLE mine (id integer)")).toMatch(/permission denied for schema public/);
      expect(await failureOf(appClient, "CREATE SCHEMA mine")).toMatch(/permission denied for database/);
    });

    it("reads and changes the data of the app's tables", async () => {
      await appClient.query("INSERT INTO things VALUES (2, 'added')");
      await appClient.query("UPDATE things SET note = 'changed' WHERE id = 2");
      await appClient.query("DELETE FROM things WHERE id = 2");
      const { rows } = await appClient.query("SELECT id, note FROM things ORDER BY id");
      expect(rows).toEqual([{ id: 1, note: "kept" }]);
    });

    it("only inserts into and reads the event tables", async () => {
      expect(EVENT_TABLES).toContain("public.events");
      await appClient.query("INSERT INTO events VALUES (2, 'appended')");
      const { rows } = await appClient.query("SELECT seq, kind FROM events ORDER BY seq");
      expect(rows).toEqual([
        { seq: "1", kind: "kept" },
        { seq: "2", kind: "appended" },
      ]);
      expect(await failureOf(appClient, "UPDATE events SET kind = 'rewritten'")).toMatch(/permission denied for table events/);
      expect(await failureOf(appClient, "DELETE FROM events")).toMatch(/permission denied for table events/);
      expect(await failureOf(appClient, "TRUNCATE events")).toMatch(/permission denied for table events/);
    });
  });

  describe("the app role and the owner", () => {
    it("cannot log in as the owner with the app role's password", async () => {
      const client = new pg.Client({ connectionString: userUrl(database.url, ownerName, app.password) });
      await expect(client.connect()).rejects.toThrow(/password authentication failed/);
      await client.end().catch(() => {});
    });

    it("cannot become the owner, or any role, from its own session", async () => {
      const quotedOwner = pg.escapeIdentifier(ownerName);
      expect(await failureOf(appClient, `SET ROLE ${quotedOwner}`)).toMatch(/permission denied to set role/);
      expect(await failureOf(appClient, `SET SESSION AUTHORIZATION ${quotedOwner}`)).toMatch(/permission denied/);
      const { rows } = await appClient.query(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
                pg_has_role(current_user, $1, 'MEMBER') AS member_of_owner
           FROM pg_roles WHERE rolname = current_user`,
        [ownerName],
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          member_of_owner: false,
        },
      ]);
    });
  });

  describe("running it again", () => {
    it("updates the app role's password, so only the new one works", async () => {
      const again: AppRole = { name: app.name, password: `new-${randomBytes(12).toString("hex")}` };
      await setUpAppRole(owner, again, FIXTURE_GRANTS);
      const old = new pg.Client({ connectionString: userUrl(database.url, app.name, app.password) });
      await expect(old.connect()).rejects.toThrow(/password authentication failed/);
      await old.end().catch(() => {});
      await withClient(userUrl(database.url, again.name, again.password), async (client) => {
        expect((await client.query("SELECT current_user AS user")).rows).toEqual([{ user: again.name }]);
      });
      app.password = again.password;
    });

    it("grants the tables the owner created since, and takes back a right the app role should not hold", async () => {
      await owner.query("CREATE TABLE later (id integer PRIMARY KEY)");
      await owner.query(`GRANT UPDATE, DELETE, TRUNCATE ON events TO ${pg.escapeIdentifier(app.name)}`);
      await setUpAppRole(owner, app, FIXTURE_GRANTS);
      await withClient(userUrl(database.url, app.name, app.password), async (client) => {
        await client.query("INSERT INTO later VALUES (1)");
        expect(await failureOf(client, "UPDATE events SET kind = 'rewritten'")).toMatch(/permission denied/);
        expect(await failureOf(client, "TRUNCATE events")).toMatch(/permission denied/);
      });
    });

    it("leaves the rights on a table and a sequence it does not know as a newer image set them", async () => {
      // A newer image made these: one table the app role may only read, one it may not touch, and their sequences.
      const quoted = pg.escapeIdentifier(app.name);
      await owner.query(`
        CREATE TABLE newer_record (id integer PRIMARY KEY, note text);
        CREATE TABLE newer_secret (id integer PRIMARY KEY);
        CREATE TABLE newer_rows (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
        CREATE SEQUENCE newer_counter;
        CREATE SEQUENCE counter;
        INSERT INTO newer_record VALUES (1, 'kept');
        GRANT SELECT ON newer_record TO ${quoted};
        GRANT SELECT, INSERT, UPDATE ON newer_rows TO ${quoted};
        GRANT UPDATE ON SEQUENCE newer_counter TO ${quoted};
      `);
      await setUpAppRole(owner, app, FIXTURE_GRANTS);
      expect(await tableRights(owner, app.name, "newer_record")).toEqual(["SELECT"]);
      expect(await tableRights(owner, app.name, "newer_secret")).toEqual([]);
      expect(await tableRights(owner, app.name, "newer_rows")).toEqual(["SELECT", "INSERT", "UPDATE"]);
      expect(await sequenceRights(owner, app.name, "newer_counter")).toEqual(["UPDATE"]);
      expect(await sequenceRights(owner, app.name, "newer_rows_id_seq")).toEqual([]);
      // The tables and the sequence it knows get their rights from scratch, as before.
      expect(await tableRights(owner, app.name, "things")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
      expect(await tableRights(owner, app.name, "events")).toEqual(["SELECT", "INSERT"]);
      expect(await sequenceRights(owner, app.name, "counter")).toEqual(["USAGE", "SELECT"]);
      await withClient(userUrl(database.url, app.name, app.password), async (client) => {
        expect((await client.query("SELECT note FROM newer_record")).rows).toEqual([{ note: "kept" }]);
        expect(await failureOf(client, "INSERT INTO newer_record VALUES (2, 'added')")).toMatch(
          /permission denied for table newer_record/,
        );
        expect(await failureOf(client, "SELECT * FROM newer_secret")).toMatch(/permission denied for table newer_secret/);
      });
    });
  });

  describe("refusals", () => {
    it("refuses to use the owner as the app role", async () => {
      await expect(setUpAppRole(owner, { name: ownerName, password: "x".repeat(32) })).rejects.toThrow(
        `The app role must not be the database owner (${ownerName}).`,
      );
    });

    it("refuses an empty password", async () => {
      await expect(setUpAppRole(owner, { name: app.name, password: "" })).rejects.toThrow(
        "The app role's password is empty.",
      );
    });

    it("refuses an existing role that holds more than the app role may, and changes nothing", async () => {
      const powerful = uniqueRole("tiehall_superuser");
      await owner.query(`CREATE ROLE ${pg.escapeIdentifier(powerful)} LOGIN SUPERUSER`);
      try {
        await expect(setUpAppRole(owner, { name: powerful, password: "x".repeat(32) })).rejects.toThrow(
          `The app role ${powerful} must not have SUPERUSER.`,
        );
        const { rows } = await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [powerful]);
        expect(rows).toEqual([{ rolpassword: null }]);
      } finally {
        await owner.query(`DROP ROLE ${pg.escapeIdentifier(powerful)}`);
      }
    });

    it("refuses an app role that can become the owner", async () => {
      const member = uniqueRole("tiehall_member");
      await owner.query(`CREATE ROLE ${pg.escapeIdentifier(member)} LOGIN IN ROLE ${pg.escapeIdentifier(ownerName)}`);
      try {
        await expect(setUpAppRole(owner, { name: member, password: "x".repeat(32) })).rejects.toThrow(
          `The app role ${member} must not be a member of the database owner (${ownerName}).`,
        );
      } finally {
        await owner.query(`DROP ROLE ${pg.escapeIdentifier(member)}`);
      }
    });
  });
});

describe("the app role's password", () => {
  let database: TestDatabase;
  let owner: pg.Client;
  const name = uniqueRole("tiehall_app_password");

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = await connect(database.url);
  });

  afterAll(async () => {
    await owner.end();
    await database.drop();
    await withClient(inject("postgresUrl"), (admin) => admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(name)}`));
  });

  it("reaches the server only as a SCRAM secret, never in plain text", async () => {
    const password = `quote' backslash\\ dollar$$ percent% ${randomBytes(6).toString("hex")}`;
    const sent: string[] = [];
    const recording = new Proxy(owner, {
      get(target, property, receiver) {
        if (property !== "query") return Reflect.get(target, property, receiver) as unknown;
        return (text: unknown, ...rest: unknown[]) => {
          sent.push(typeof text === "string" ? text : JSON.stringify(text));
          sent.push(JSON.stringify(rest));
          return (target.query as (...args: unknown[]) => unknown).call(target, text, ...rest);
        };
      },
    });
    await setUpAppRole(recording, { name, password });
    expect(sent.join("\n")).not.toContain(password);
    const { rows } = await owner.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [
      name,
    ]);
    expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    await withClient(userUrl(database.url, name, password), async (client) => {
      expect((await client.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  });

  it("logs in with characters that SASLprep maps, as the Postgres driver sends them", async () => {
    // A no-break space and a soft hyphen, which SASLprep maps to a space and to nothing.
    const password = `café pass­word ${randomBytes(6).toString("hex")}`;
    await setUpAppRole(owner, { name, password });
    await withClient(userUrl(database.url, name, password), async (client) => {
      expect((await client.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  });

  it("gets a fresh salt each time", () => {
    expect(scramSha256Secret("same")).not.toBe(scramSha256Secret("same"));
  });
});

describe("an owner that is not a superuser, as on an external Postgres", () => {
  let database: TestDatabase;
  let admin: pg.Client;
  const ownerName = uniqueRole("tiehall_owner");
  const ownerPassword = `owner-${randomBytes(12).toString("hex")}`;
  const app: AppRole = { name: uniqueRole("tiehall_app_external"), password: `app-${randomBytes(12).toString("hex")}` };

  beforeAll(async () => {
    // The container's superuser, as the operator of an external Postgres would be.
    admin = await connect(inject("postgresUrl"));
    await admin.query(
      `CREATE ROLE ${pg.escapeIdentifier(ownerName)} LOGIN CREATEROLE PASSWORD ${pg.escapeLiteral(ownerPassword)}`,
    );
    database = await createTestDatabase({ owner: ownerName });
  });

  afterAll(async () => {
    await database.drop();
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(app.name)}`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(ownerName)}`);
    await admin.end();
  });

  it("creates the app role and grants it the owner's tables", async () => {
    await withClient(userUrl(database.url, ownerName, ownerPassword), async (owner) => {
      await owner.query(FIXTURE_TABLES);
      await setUpAppRole(owner, app, FIXTURE_GRANTS);
    });
    await withClient(userUrl(database.url, app.name, app.password), async (client) => {
      await client.query("UPDATE things SET note = 'changed'");
      expect(await failureOf(client, "UPDATE events SET kind = 'rewritten'")).toMatch(/permission denied/);
      expect(await failureOf(client, "DROP TABLE things")).toMatch(/must be owner/);
    });
  });
});

describe("the tables this image knows", () => {
  it("are the tables and the sequence its schema defines, and hold every table the rights lists name", () => {
    expect(IMAGE_TABLES).toContain("public.events");
    expect(IMAGE_TABLES).toContain("public.backups");
    expect(IMAGE_TABLES.every((table) => table.startsWith("public."))).toBe(true);
    expect(IMAGE_SEQUENCES).toEqual(["public.members_token_generation_seq"]);
    for (const table of [...APPEND_ONLY_TABLES, ...READ_ONLY_TABLES]) expect(IMAGE_TABLES, table).toContain(table);
  });
});

describe("the migrate step after a newer release", () => {
  // self-host-install: Only the migrate step holds the database owner's credentials, "An older image leaves a
  // newer table's rights alone": release 1.4.0 made a table that the app role may only read, and the operator
  // went back to 1.3.0, whose migrate step runs on 1.4.0's schema.
  const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
  let database: TestDatabase;
  let owner: pg.Client;
  const appRole: AppRole = { name: uniqueRole("tiehall_app_rollback"), password: randomBytes(16).toString("hex") };

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    owner = await connect(database.url);
  });

  afterAll(async () => {
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
    await owner.end();
    await database.drop();
  });

  it("keeps a table it does not know read-only, and sets a known table's rights from scratch", async () => {
    const quoted = pg.escapeIdentifier(appRole.name);
    await owner.query(`CREATE TABLE release_archive (id integer PRIMARY KEY); GRANT SELECT ON release_archive TO ${quoted}`);
    // A right that no image gives, on a known table, and one taken away from another.
    await owner.query(`GRANT TRUNCATE, UPDATE ON backups TO ${quoted}; REVOKE ALL ON teams FROM ${quoted}`);
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    expect(await tableRights(owner, appRole.name, "release_archive")).toEqual(["SELECT"]);
    expect(await tableRights(owner, appRole.name, "backups")).toEqual(["SELECT"]);
    expect(await tableRights(owner, appRole.name, "teams")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(await tableRights(owner, appRole.name, "events")).toEqual(["SELECT", "INSERT"]);
  });
});
