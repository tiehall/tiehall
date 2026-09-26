import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The migration lint (self-host-install: Migrations expand, then contract). A
// release's migrations only add to the schema: a step that drops, renames or
// rewrites a table or column, or sets NOT NULL, must be marked as a contract
// step that names the release of the expand step it follows, and no migration
// changes data, because backfills run as batched background jobs. It runs the
// same script as the CI job, against fixtures and the real migrations.

const script = fileURLToPath(new URL("../src/check-migrations.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/migration-lint/${name}/`, import.meta.url));

function lint(folder?: string) {
  const run = spawnSync(process.execPath, [script, ...(folder === undefined ? [] : [folder])], { encoding: "utf8" });
  if (run.error) throw run.error;
  return { status: run.status, stdout: run.stdout, problems: run.stderr.split("\n").filter((line) => /^\d{4}_/.test(line)) };
}

describe("the migration lint", () => {
  it("fails a step that drops or renames a table or a column without the contract mark", () => {
    const run = lint(fixture("drops"));
    expect(run.status).toBe(1);
    expect(run.problems).toEqual([
      '0000_drop_note: drops a column, which only a contract step may do: ALTER TABLE "things" DROP COLUMN "note"',
      '0001_drop_old_things: drops a table, which only a contract step may do: DROP TABLE "old_things" CASCADE',
      "0002_rename_name: renames a table or a column, which only a contract step may do: " +
        'ALTER TABLE "things" RENAME COLUMN "name" TO "title"',
    ]);
  });

  it("fails a step that sets NOT NULL on an existing column, or adds a NOT NULL column without a default", () => {
    const run = lint(fixture("sets-not-null"));
    expect(run.status).toBe(1);
    expect(run.problems).toEqual([
      "0000_require_name: sets NOT NULL on an existing column, which only a contract step may do: " +
        'ALTER TABLE "things" ALTER COLUMN "name" SET NOT NULL',
      "0001_add_required_kind: adds a NOT NULL column without a default, which only a contract step may do: " +
        'ALTER TABLE "things" ADD COLUMN "kind" text NOT NULL',
    ]);
  });

  it("fails a step that rewrites a table", () => {
    const run = lint(fixture("rewrites"));
    expect(run.status).toBe(1);
    expect(run.problems).toEqual([
      "0000_widen_id: rewrites the table, which only a contract step may do: " +
        'ALTER TABLE "things" ALTER COLUMN "id" SET DATA TYPE bigint',
      "0001_add_random_key: rewrites the table, which only a contract step may do: " +
        'ALTER TABLE "things" ADD COLUMN "key" uuid DEFAULT gen_random_uuid()',
    ]);
  });

  it("fails a backfill in any migration, a contract step included", () => {
    const run = lint(fixture("backfill"));
    expect(run.status).toBe(1);
    expect(run.problems).toEqual([
      '0000_lower_names: changes data, which a migration never does: UPDATE "things" SET "lower_name" = lower("name")',
      '0001_marked_backfill: changes data, which a migration never does: DELETE FROM "things" WHERE "name" IS NULL',
      "0002_backfill_in_a_block: changes data, which a migration never does: " +
        `DO $body$ BEGIN -- A ; inside the block does not end the statement. UPDATE "things" SET "name" = 'x'…`,
    ]);
    expect(run.stdout).toBe("");
  });

  it("fails a contract mark that names no release", () => {
    const run = lint(fixture("malformed-contract"));
    expect(run.status).toBe(1);
    expect(run.problems).toEqual([
      '0000_drop_note: has a malformed directive "-- migrate: contract after soon"; a contract step names the ' +
        'release of the expand step it follows, as in "-- migrate: contract after 1.3.0"',
      '0000_drop_note: drops a column, which only a contract step may do: ALTER TABLE "things" DROP COLUMN "note"',
    ]);
  });

  it("passes a contract step marked with the release of its expand step", () => {
    const run = lint(fixture("marked-contract"));
    expect(run.problems).toEqual([]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 migration; every step that removes or rewrites is a marked contract step");
  });

  it("passes migrations that only add, whatever their comments and strings say", () => {
    const run = lint(fixture("expand-only"));
    expect(run.problems).toEqual([]);
    expect(run.status).toBe(0);
  });

  it("passes the real migrations, which it checks by default", () => {
    const run = lint();
    expect(run.problems).toEqual([]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^packages\/db\/migrations: \d+ migrations?; /);
  });
});
