import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compareDocuments } from "./api-compat.ts";

// CI's compatibility check on a pull request (public-api: Notice before a
// breaking change is enforced in CI): it compares openapi/v1.json at the pull
// request's merge base with the pull request's, through the pinned oasdiff.
// Usage: node tools/repo-checks/src/check-api-compat.ts [base-ref]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseRef = process.argv[2] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
let base: string;
try {
  base = git("show", `${mergeBase}:openapi/v1.json`);
} catch {
  console.log(`openapi/v1.json does not exist at the merge base ${mergeBase.slice(0, 12)}, so there is nothing to compare.`);
  process.exit(0);
}
const result = await compareDocuments(base, readFileSync(`${root}openapi/v1.json`, "utf8"));
if (result.passed) {
  console.log(`openapi/v1.json keeps the notice rules against the merge base ${mergeBase.slice(0, 12)}.`);
} else {
  console.error(`openapi/v1.json breaks the notice rules against the merge base ${mergeBase.slice(0, 12)}:`);
  for (const { id, text, operationId } of result.errors) console.error(`- ${operationId === undefined ? "" : `${operationId}: `}${text} [${id}]`);
  console.error(
    "A beta operation changes in three steps: add the new shape, deprecate the old one with an x-sunset at least 14 days later " +
      "(180 for a stable one), and remove it on or after that date; every breaking change bumps info.version.",
  );
  process.exitCode = 1;
}
