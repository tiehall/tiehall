import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { READ_ONLY_TABLES } from "../src/database-roles.ts";
import { migrate } from "../src/migrate.ts";

// The record of finished backups (self-host-install: Backups with the shipped
// scripts; self-host-install: The admin page warns about missing backups;
// design.md, Self-hosting decisions: S11). backup.sh runs on the host and
// records each backup that finished as the database owner; the app only reads
// the record for the admin page, so the app role may only select from it.

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));

let database: TestDatabase;
let owner: pg.Client;
let app: pg.Client;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };

async function failureOf(client: pg.Client, sql: string): Promise<string | undefined> {
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
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
  await owner.query("INSERT INTO orgs (name, setup_completed_at) VALUES ('Acme', now())");
});

afterAll(async () => {
  await app.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

describe("the record of finished backups", () => {
  it("takes the owner's record of a finished backup, which the app role reads", async () => {
    await owner.query(
      "INSERT INTO backups (org_id, finished_at, file, size_bytes) SELECT id, now(), 'tiehall-20261001T020000Z.dump', 4096 FROM orgs",
    );
    const { rows } = await app.query<{ file: string }>("SELECT file FROM backups");
    expect(rows).toEqual([{ file: "tiehall-20261001T020000Z.dump" }]);
  });

  it("is read-only to the app role: it cannot add, change or remove a record", async () => {
    expect(READ_ONLY_TABLES).toEqual(["public.backups"]);
    const denied = /permission denied for table backups/;
    expect(await failureOf(app, "INSERT INTO backups (org_id, finished_at, file, size_bytes) SELECT id, now(), 'x.dump', 1 FROM orgs")).toMatch(denied);
    expect(await failureOf(app, "UPDATE backups SET finished_at = now()")).toMatch(denied);
    expect(await failureOf(app, "DELETE FROM backups")).toMatch(denied);
  });
});
