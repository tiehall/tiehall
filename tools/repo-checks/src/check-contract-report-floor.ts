// CI's check of contract.report's own CLI floor (public-api:
// `contract.report` has its own version floor): it compares the floor in
// packages/core/src/client-versions.ts at the pull request's merge base with
// the pull request's, and fails when the floor rises without an entry of
// openapi/changelog.json about contract.report, naming the new floor, dated at
// least 180 days earlier (contract-report-floor.ts).
// Usage: node tools/repo-checks/src/check-contract-report-floor.ts [base-ref]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "@tiehall/catalog/changelog";
import { floorOf, floorRiseProblems } from "./contract-report-floor.ts";

const SOURCE = "packages/core/src/client-versions.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseRef = process.argv[2] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
let baseSource: string | undefined;
try {
  baseSource = git("show", `${mergeBase}:${SOURCE}`);
} catch {
  baseSource = undefined;
}
const floor = floorOf(readFileSync(`${root}${SOURCE}`, "utf8"));
if (floor === undefined) {
  console.error(`${SOURCE} sets no MINIMUM_CONTRACT_REPORT_CLI_VERSION, which this check reads.`);
  process.exit(1);
}
const baseFloor = baseSource === undefined ? undefined : floorOf(baseSource);
if (baseFloor === undefined) {
  console.log(`contract.report's CLI floor is ${floor}; the merge base ${mergeBase.slice(0, 12)} sets none to compare with.`);
  process.exit(0);
}
const problems = floorRiseProblems({ baseFloor, floor, changelog: parseChangelog(readFileSync(`${root}openapi/changelog.json`, "utf8")), today: new Date() });
if (problems.length === 0) {
  console.log(`contract.report's CLI floor is ${floor}, against ${baseFloor} at the merge base ${mergeBase.slice(0, 12)}: it keeps the notice rule.`);
} else {
  for (const problem of problems) console.error(problem);
  console.error(
    "\nCompanies' CI runs the CLI version the contract Action pins, so the floor rises only after 180 days' notice: add an entry " +
      "about contract.report to openapi/changelog.json naming the new floor, and raise the floor in a release at least 180 days later.",
  );
  process.exitCode = 1;
}
