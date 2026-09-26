import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate, openDatabase, SetupRequiredError, withOrg, type Database } from "../src/index.ts";

// withOrg() (teams-and-roles: One org per install; design.md, Technical
// decisions: T3 and Self-hosting decisions: S1): the only way a handler in
// packages/commands reaches the database. It opens the transaction the handler
// runs in, for the install's one org, and hands the handler that org's id.
// There is no tenant layer, so it sets no row-level-security setting. It
// connects as the app role, as the app does.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

describe("withOrg", () => {
  let database: TestDatabase;
  let owner: pg.Client;
  let db: Database;
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    // A table of the kind later tasks add, which handlers write to.
    await owner.query(
      `CREATE TABLE notes (
         org_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), body text NOT NULL,
         PRIMARY KEY (org_id, id))`,
    );
    await migrate(
      { connectionString: database.url },
      { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} },
    );
    const url = new URL(database.url);
    url.username = appRole.name;
    url.password = "";
    db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  });

  afterAll(async () => {
    await db.$client.end();
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
    await owner.end();
    await database.drop();
  });

  describe("before setup has named the org", () => {
    it("refuses to run the handler, because setup is not complete", async () => {
      let ran = false;
      await expect(
        withOrg(db, async () => {
          ran = true;
        }),
      ).rejects.toThrow(new SetupRequiredError());
      expect(ran).toBe(false);
    });
  });

  describe("once the install has its org", () => {
    let orgId: string;

    beforeEach(async () => {
      orgId = (await owner.query<{ id: string }>("INSERT INTO orgs (name) VALUES ('Acme') RETURNING id")).rows[0]?.id ?? "";
    });

    afterEach(async () => {
      await owner.query("DELETE FROM notes; DELETE FROM orgs");
    });

    it("gives the handler the install's org id", async () => {
      expect(await withOrg(db, async (context) => context.orgId)).toBe(orgId);
    });

    it("runs the handler in one transaction, which commits when the handler returns", async () => {
      const seenOutside = await withOrg(db, async ({ tx, orgId }) => {
        await tx.execute(`INSERT INTO notes (org_id, body) VALUES ('${orgId}', 'kept')`);
        return (await owner.query("SELECT body FROM notes")).rows;
      });
      expect(seenOutside).toEqual([]);
      expect((await owner.query("SELECT body FROM notes")).rows).toEqual([{ body: "kept" }]);
    });

    it("rolls the transaction back when the handler throws, leaving no row", async () => {
      const failure = new Error("the handler failed after writing");
      await expect(
        withOrg(db, async ({ tx, orgId }) => {
          await tx.execute(`INSERT INTO notes (org_id, body) VALUES ('${orgId}', 'rolled back')`);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect((await owner.query("SELECT body FROM notes")).rows).toEqual([]);
    });

    it("sets no row-level-security setting", async () => {
      const settings = await withOrg(db, async ({ tx }) => {
        // A setting that a policy could read is a custom one, whose name has a dot, such as app.org_id.
        const { rows } = await tx.execute("SELECT name FROM pg_settings WHERE name LIKE '%.%'");
        return rows;
      });
      expect(settings).toEqual([]);
      expect((await owner.query("SELECT count(*)::int AS policies FROM pg_policies")).rows).toEqual([{ policies: 0 }]);
    });
  });
});
