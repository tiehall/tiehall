// CI check: the migration lint (self-host-install: Migrations expand, then
// contract). Uses only Node built-ins, so it runs without an install.
// Usage: node packages/db/src/check-migrations.ts [migrations folder]
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lintMigrationFolder } from "./migration-lint.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const folder = resolve(process.argv[2] ?? fileURLToPath(new URL("../migrations/", import.meta.url)));
const label = relative(repoRoot, folder) || ".";

const { migrations, problems } = lintMigrationFolder(folder);
if (problems.length === 0) {
  console.log(
    `${label}: ${migrations} migration${migrations === 1 ? "" : "s"}; every step that removes or rewrites is a ` +
      "marked contract step, and none changes data.",
  );
} else {
  console.error(`${label}:`);
  for (const { migration, message } of problems) console.error(`${migration}: ${message}`);
  console.error(
    "\nA release's migrations only add to the schema, so the previous release still runs on it. Mark a step " +
      'that drops, renames, rewrites or sets NOT NULL as a contract step with "-- migrate: contract after ' +
      '<release>", naming the release of the expand step it follows, and ship it at least one release after ' +
      "that one. Backfills run as batched background jobs, never inside a migration.",
  );
  process.exitCode = 1;
}
