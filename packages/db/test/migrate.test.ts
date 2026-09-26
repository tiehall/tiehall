import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate } from "../src/migrate.ts";

// The migrate role's entry point: it connects as the database owner, applies
// the real migrations, and sets up the app role (self-host-install: Only the
// migrate step holds the database owner's credentials). The runner itself is
// tested against fixtures in migration-runner.test.ts.

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const quiet = { migrationsFolder, log: () => {} };

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
    await expect(migrate({ connectionString: url.toString(), password }, quiet)).resolves.toBeUndefined();
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
    // A database of its own that the role owns, as the owner the migrate step connects as.
    const owned = await createTestDatabase({ owner: "migrate_test_role" });
    try {
      const url = new URL(owned.url);
      url.username = "migrate_test_role";
      url.password = "";
      await expect(migrate({ connectionString: url.toString(), password }, quiet)).resolves.toBeUndefined();
    } finally {
      await owned.drop();
    }
  });

  it("creates the app role it is given, which then logs in with its own password", async () => {
    const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
    try {
      await migrate({ connectionString: database.url }, { ...quiet, appRole });
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
    await expect(migrate({ connectionString: database.url, password: "not-the-password" }, quiet)).rejects.toThrow(
      /password authentication failed/,
    );
  });
});
