import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate } from "../src/migrate.ts";

// The migrate role's entry point. Task 3.2 turns it into the migration runner;
// until then it checks that the database accepts the role's connection.

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

  it("fails when the database refuses the password", async () => {
    await expect(migrate({ connectionString: database.url, password: "not-the-password" })).rejects.toThrow(
      /password authentication failed/,
    );
  });
});
