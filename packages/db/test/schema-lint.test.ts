import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { migrate } from "../src/migrate.ts";
import { lintOrgIds } from "../src/schema-lint.ts";

// One org per install (teams-and-roles: One org per install; design.md,
// Self-hosting decisions: S1). The install has one org row, and every other
// table carries org_id, keyed as (org_id, id), with org_id in every foreign key,
// so a later version can hold several orgs without rewriting a table. The lint
// reads the catalog of a database the real migrations built, so it sees every
// table they make, whether drizzle-kit wrote the migration or a person did.

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/schema-lint/${name}.sql`, import.meta.url), "utf8");

let database: TestDatabase;
let owner: pg.Client;

beforeEach(async () => {
  database = await createTestDatabase();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", log: () => {} });
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
});

afterEach(async () => {
  await owner.end();
  await database.drop();
});

describe("the orgs table", () => {
  it("holds the install's one org, and refuses a second", async () => {
    await owner.query("INSERT INTO orgs (name) VALUES ('Acme')");
    await expect(owner.query("INSERT INTO orgs (name) VALUES ('Another company')")).rejects.toThrow(
      /duplicate key value violates unique constraint "orgs_one_row"/,
    );
    expect((await owner.query("SELECT name FROM orgs")).rows).toEqual([{ name: "Acme" }]);
  });
});

describe("the org id lint", () => {
  it("passes the real schema", async () => {
    expect(await lintOrgIds(owner)).toEqual([]);
  });

  it("fails a table without org_id", async () => {
    await owner.query(fixture("table-without-org-id"));
    expect(await lintOrgIds(owner)).toEqual([
      "public.notes has no org_id column; every table but orgs belongs to the install's org.",
    ]);
  });

  it("fails a foreign key that leaves org_id out", async () => {
    await owner.query(fixture("foreign-key-without-org-id"));
    expect(await lintOrgIds(owner)).toEqual([
      "public.members: foreign key members_team_id_teams_id_fk (team_id) to public.teams (id) leaves out org_id; " +
        "it should be (org_id, team_id) to (org_id, id).",
    ]);
  });

  it("fails an org_id that may be null, is not in the primary key or does not reference orgs", async () => {
    await owner.query(fixture("key-without-org-id"));
    expect(await lintOrgIds(owner)).toEqual([
      "public.labels: org_id may be null.",
      "public.labels: its primary key (id) does not start with org_id, as (org_id, id) does.",
      "public.labels: org_id does not reference orgs (id).",
    ]);
  });

  it("passes tables keyed by org, one row per org included", async () => {
    await owner.query(fixture("keyed-by-org"));
    expect(await lintOrgIds(owner)).toEqual([]);
  });
});
