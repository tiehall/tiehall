// CI check: fails when a server package depends on a package that parses,
// dereferences, validates or diffs OpenAPI documents, from
// openapi-reader-denylist.json, or when a server package's code calls one of
// GitHub's endpoints that read a repository's files (contract-changes:
// Contract diffs run only where the specs already are). Uses only Node
// built-ins, so it needs no install.
// Usage: node tools/repo-checks/src/check-spec-reading.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { findContentsCalls, findReaderDependencies, loadReaderDenylist, SERVER_APPS } from "./spec-reading.ts";

const root = resolve(process.argv[2] ?? ".");
const denylist = loadReaderDenylist();

const dependencies = findReaderDependencies(root, denylist);
for (const { file, field, name, as, listedAs } of dependencies) {
  const alias = as === name ? "" : ` (installed as "${as}")`;
  const why = Object.hasOwn(denylist.packages, listedAs) ? denylist.packages[listedAs] : denylist.scopes[listedAs];
  console.error(`${file}: ${field} has ${name}${alias}, which the denylist names as ${listedAs} (${why ?? "listed"}).`);
}
const calls = findContentsCalls(root);
for (const { file, line, reads } of calls) console.error(`${file}:${line}: calls ${reads}.`);

if (dependencies.length > 0 || calls.length > 0) {
  console.error(
    `\nNothing on the server reads OpenAPI documents: contract diffs run only in the provider's CI and on developers' machines, ` +
      `and the GitHub App has no access to repository contents. The server packages are ${SERVER_APPS.join(" and ")} and the workspace ` +
      "packages they depend on; the denylist is tools/repo-checks/openapi-reader-denylist.json.\n",
  );
  process.exitCode = 1;
} else {
  console.log("No server package depends on an OpenAPI parser or diff tool, or calls GitHub's endpoints that read a repository's files.");
}
