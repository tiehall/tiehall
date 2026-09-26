import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate, MigrationError } from "../src/migrate.ts";

// The schema floor (self-host-install: Migrations expand, then contract;
// design.md, Self-hosting decisions: S12). Until a contract step has run, the
// previous release's image runs on the newer schema, so going back only takes
// switching the image. A contract step records the release that ran it; after
// it, an image from before that step refuses to start, naming both releases,
// and the way back is the backup taken before the upgrade.
//
// Each fixture folder is one release's migrations: 1.3.0 expands (adds
// "title"), and 1.4.0 contracts (drops "name", which 1.2.0 still reads).

const release = (version: string) => fileURLToPath(new URL(`./fixtures/migrations/releases/${version}/`, import.meta.url));

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

/** Runs the migrate step of the image of a release, whose migrations are those of `migrations`. */
async function runImage(version: string, migrations = version): Promise<string[]> {
  const lines: string[] = [];
  await migrate(
    { connectionString: database.url },
    { migrationsFolder: release(migrations), release: version, log: (line) => lines.push(line) },
  );
  return lines;
}

describe("the schema floor", () => {
  it("lets the previous image's migrate start on the newer schema before any contract step has run", async () => {
    await runImage("1.2.0");
    await runImage("1.3.0");
    expect(await runImage("1.2.0")).toEqual([
      "migrate: the schema is up to date; it also has 1 migration from a later release, which this release runs on",
    ]);
    await owner.query("INSERT INTO things (id, name) VALUES (1, 'written by 1.2.0')");
  });

  it("records the release that ran each migration, and the expand release a contract step follows", async () => {
    await runImage("1.2.0");
    await runImage("1.4.0");
    const { rows } = await owner.query(
      "SELECT id, release, contract_after FROM tiehall_migrate.applied_migrations ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "0000_create_things", release: "1.2.0", contract_after: null },
      { id: "0001_add_title", release: "1.4.0", contract_after: null },
      { id: "0002_drop_name", release: "1.4.0", contract_after: "1.3.0" },
    ]);
  });

  it("refuses an image from before a contract step that has run, naming both releases", async () => {
    await runImage("1.2.0");
    await runImage("1.3.0");
    await runImage("1.4.0");
    for (const version of ["1.3.0", "1.2.0"]) {
      await expect(runImage(version)).rejects.toThrow(
        new MigrationError(
          `This image is release ${version}, which is older than this database's schema: its contract step ` +
            "0002_drop_name ran with release 1.4.0, so the schema needs release 1.4.0 or later. To go back past " +
            "a contract step, restore the backup taken before the upgrade.",
        ),
      );
    }
    const { rows } = await owner.query("SELECT id FROM tiehall_migrate.applied_migrations ORDER BY id");
    expect(rows.map(({ id }) => id)).toEqual(["0000_create_things", "0001_add_title", "0002_drop_name"]);
  });

  it("starts any image that has the contract step, whatever its version says", async () => {
    await runImage("1.4.0");
    expect(await runImage("1.4.1", "1.4.0")).toEqual(["migrate: the schema is up to date"]);
    // A build from main before its release carries a development version.
    expect(await runImage("0.0.0-dev", "1.4.0")).toEqual(["migrate: the schema is up to date"]);
  });
});
