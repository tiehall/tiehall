import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrationsFolderFor, runMigrateRole } from "../src/migrate-role.ts";

// The image's migrate role (self-host-install: Upgrades apply migrations before
// the app starts): it applies the migrations and exits 0, or exits non-zero with
// the reason in its log, so the app does not start on the new image.

const fixture = fileURLToPath(new URL("./fixtures/migrations/add-note/", import.meta.url));

describe("the migrate role", () => {
  let database: TestDatabase;
  let owner: pg.Client;
  let out: string[];
  let errors: string[];

  beforeEach(async () => {
    database = await createTestDatabase();
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    await owner.query('CREATE TABLE "things" ("id" integer PRIMARY KEY)');
    out = [];
    errors = [];
  });

  afterEach(async () => {
    await owner.end();
    await database.drop();
  });

  function run(lockTimeoutMs?: number): Promise<number> {
    return runMigrateRole(
      { databaseUrl: database.url, port: 3000 },
      {
        migrationsFolder: fixture,
        release: "1.0.0",
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
        log: (line) => out.push(line),
        logError: (line) => errors.push(line),
      },
    );
  }

  it("applies the migrations, logs each one and exits 0", async () => {
    expect(await run()).toBe(0);
    expect(out).toEqual(["tiehall migrate: applied 0000_add_note", "tiehall migrate: done"]);
    expect(errors).toEqual([]);
  });

  it("exits non-zero with the reason in its log when a migration is blocked by a held lock", async () => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM things");
      expect(await run(300)).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(errors).toEqual([
      "tiehall migrate: failed: Migration 0000_add_note failed: canceling statement due to lock timeout. It waited " +
        "more than 300 ms for a lock that another session holds, such as a long transaction of the running app; " +
        "nothing of it was applied, and running migrate again retries it.",
    ]);
    expect(out).not.toContain("tiehall migrate: done");
  });
});

describe("the migrations folder", () => {
  it("sits at packages/db/migrations beside the image's entrypoint", () => {
    expect(migrationsFolderFor("/app/apps/server/dist/main.mjs")).toBe("/app/packages/db/migrations");
  });

  it("is the repository's migrations folder when the entrypoint runs from source", () => {
    const folder = migrationsFolderFor(fileURLToPath(new URL("../src/main.ts", import.meta.url)));
    expect(folder).toBe(fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)));
    expect(existsSync(join(folder, "meta", "_journal.json"))).toBe(true);
  });
});
