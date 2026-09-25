import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate } from "../src/migrate.ts";

// The migrate role's entry point: it connects as the database owner and sets
// up the app role (self-host-install: Only the migrate step holds the database
// owner's credentials). Task 4.2 adds the migration runner.

describe("migrate", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it("connects with the URL and the password given apart from it", async () => {
    const url = new URL(database.url);
    const password = decodeURIComponent(url.password);
    url.password = "";
    await expect(migrate({ connectionString: url.toString(), password })).resolves.toBeUndefined();
  });

  it("keeps a password with URL delimiters and percent signs intact", async () => {
    const password = "p@ss:w/rd%41?#&+ é";
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query("DROP ROLE IF EXISTS migrate_test_role");
      await admin.query(`CREATE ROLE migrate_test_role LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    } finally {
      await admin.end();
    }
    const url = new URL(database.url);
    url.username = "migrate_test_role";
    url.password = "";
    await expect(migrate({ connectionString: url.toString(), password })).resolves.toBeUndefined();
  });

  it("creates the app role it is given, which then logs in with its own password", async () => {
    const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
    try {
      await migrate({ connectionString: database.url }, { appRole });
      const url = new URL(database.url);
      url.username = appRole.name;
      url.password = appRole.password;
      const app = new pg.Client({ connectionString: url.toString() });
      await app.connect();
      try {
        expect((await app.query("SELECT current_user AS user")).rows).toEqual([{ user: appRole.name }]);
      } finally {
        await app.end();
      }
    } finally {
      await database.drop();
      database = await createTestDatabase();
      const admin = new pg.Client({ connectionString: inject("postgresUrl") });
      await admin.connect();
      await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(appRole.name)}`).finally(() => admin.end());
    }
  });

  it("fails when the database refuses the password", async () => {
    await expect(migrate({ connectionString: database.url, password: "not-the-password" })).rejects.toThrow(
      /password authentication failed/,
    );
  });
});
