import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate, MigrationError, type MigrateOptions } from "../src/migrate.ts";

// The migration runner of the migrate role (self-host-install: Upgrades apply
// migrations before the app starts; design.md, Technical decisions: T4). It
// holds an advisory lock while it runs, applies each migration in order and
// once, sets lock_timeout so a migration blocked by the running app fails fast
// instead of queueing every query behind it, and runs non-transactional steps
// such as CREATE INDEX CONCURRENTLY apart from the transactional ones.

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/migrations/${name}/`, import.meta.url));

let database: TestDatabase;
let owner: pg.Client;

beforeEach(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
});

afterEach(async () => {
  await owner.end();
  await database.drop();
});

function run(folder: string, options: Omit<MigrateOptions, "migrationsFolder" | "release"> = {}) {
  const lines: string[] = [];
  const done = migrate(
    { connectionString: database.url },
    { migrationsFolder: fixture(folder), release: "1.0.0", log: (line) => lines.push(line), ...options },
  );
  return { lines, done };
}

async function applied(): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>("SELECT id FROM tiehall_migrate.applied_migrations ORDER BY id");
  return rows.map(({ id }) => id);
}

describe("the migration runner", () => {
  it("applies each migration once when two runners start together", async () => {
    const first = run("ordered");
    const second = run("ordered");
    await Promise.all([first.done, second.done]);

    const { rows } = await owner.query("SELECT step FROM migration_log");
    expect(rows).toEqual([{ step: 1 }]);
    expect(await applied()).toEqual(["0000_create_log", "0001_record_step"]);
    // One runner applied both migrations while the other waited for the lock, then found nothing to do.
    const logs = [first.lines, second.lines];
    expect(logs.filter((lines) => lines.includes("migrate: applied 0001_record_step"))).toHaveLength(1);
    expect(logs.flat()).toContain("migrate: waiting for another migrate step to finish");
    expect(logs.flat()).toContain("migrate: the schema is up to date");
  });

  it("applies nothing on a later run", async () => {
    await run("ordered").done;
    const again = run("ordered");
    await again.done;
    expect(again.lines).toEqual(["migrate: the schema is up to date"]);
    expect((await owner.query("SELECT step FROM migration_log")).rows).toEqual([{ step: 1 }]);
  });

  it("fails a migration blocked by a held lock within its timeout, applying nothing of it", async () => {
    await owner.query('CREATE TABLE "things" ("id" integer PRIMARY KEY)');
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      // A long transaction in the running app that has read the table.
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM things");
      const started = Date.now();
      const blocked = run("blocked", { lockTimeoutMs: 300 });
      await expect(blocked.done).rejects.toThrow(
        new MigrationError(
          "Migration 0000_add_note failed: canceling statement due to lock timeout. It waited more than 300 ms for " +
            "a lock that another session holds, such as a long transaction of the running app; nothing of it was " +
            "applied, and running migrate again retries it.",
        ),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await applied()).toEqual([]);
    const columns = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'things'");
    expect(columns.rows).toEqual([{ column_name: "id" }]);

    await run("blocked").done;
    expect(await applied()).toEqual(["0000_add_note"]);
  });

  it("applies a concurrent-index step outside a transaction", async () => {
    const { lines, done } = run("concurrent-index");
    await done;
    expect(lines).toContain("migrate: applied 0001_index_thing_names, outside a transaction");
    const { rows } = await owner.query(
      "SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = 'public.things_name'::regclass",
    );
    expect(rows).toEqual([{ indisvalid: true, indisunique: true }]);
    expect(await applied()).toEqual(["0000_create_things", "0001_index_thing_names"]);
  });

  it("builds again a concurrent index that a failed run left invalid", async () => {
    // Duplicate names make the unique index build fail halfway, which leaves an invalid index behind.
    await owner.query('CREATE TABLE "things" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL)');
    await owner.query("INSERT INTO things VALUES (1, 'same'), (2, 'same')");
    await expect(run("concurrent-index").done).rejects.toThrow(
      new MigrationError('Migration 0001_index_thing_names failed: could not create unique index "things_name".'),
    );
    const invalid = await owner.query("SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.things_name'::regclass");
    expect(invalid.rows).toEqual([{ indisvalid: false }]);
    expect(await applied()).toEqual(["0000_create_things"]);

    await owner.query("UPDATE things SET name = 'other' WHERE id = 2");
    const again = run("concurrent-index");
    await again.done;
    expect(again.lines).toEqual([
      "migrate: dropped the invalid index public.things_name that an earlier run left, to build it again",
      "migrate: applied 0001_index_thing_names, outside a transaction",
    ]);
    const valid = await owner.query("SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.things_name'::regclass");
    expect(valid.rows).toEqual([{ indisvalid: true }]);
  });

  it("stops at a failing migration, keeping the ones before it and nothing of it", async () => {
    const { lines, done } = run("failing");
    await expect(done).rejects.toThrow(
      new MigrationError('Migration 0001_breaks_halfway failed: relation "no_such_table" does not exist.'),
    );
    expect(lines).toEqual(["migrate: applied 0000_create_things"]);
    expect(await applied()).toEqual(["0000_create_things"]);
    const columns = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'things'");
    expect(columns.rows).toEqual([{ column_name: "id" }]);
  });

  it("refuses to run when a migration it applied has changed since", async () => {
    await run("ordered").done;
    await owner.query("UPDATE tiehall_migrate.applied_migrations SET hash = 'edited' WHERE id = '0000_create_log'");
    await expect(run("ordered").done).rejects.toThrow(
      new MigrationError(
        "Migration 0000_create_log has changed since it was applied to this database. Released migrations never " +
          "change; fix a problem with a new migration.",
      ),
    );
  });

  it("keeps its record of applied migrations away from the app role", async () => {
    const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
    // The fixture's migrations make a table the image's own do not.
    await run("ordered", { appRole, alsoKnownTables: ["public.migration_log"] }).done;
    const url = new URL(database.url);
    url.username = appRole.name;
    url.password = appRole.password;
    const app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
    try {
      await expect(app.query("SELECT id FROM tiehall_migrate.applied_migrations")).rejects.toThrow(
        /permission denied for schema tiehall_migrate/,
      );
      await expect(app.query("SELECT step FROM migration_log")).resolves.toMatchObject({ rows: [{ step: 1 }] });
    } finally {
      await app.end();
      // Takes back the role's rights in this database, so the role can be dropped.
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
    }
  });
});
