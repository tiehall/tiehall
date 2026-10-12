import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseLabels } from "./api-compat.ts";
import { exclusionsIn, releaseAgeLabelProblems } from "./release-age.ts";

// The API-compatibility workflow's label step for exceptions to the release
// age (self-host-install: Release pipeline integrity;
// decisions-from-groups-15-28: design.md, Technical decisions: T16): it
// compares the exclusions from the 7-day release age in pnpm-workspace.yaml
// at the pull request's merge base with the pull request's, and fails a pull
// request that adds one without the release-age-exception label. pnpm
// check:workflows checks each exclusion's record and its day.
// Usage: node tools/repo-checks/src/check-release-age-label.ts [base-ref] [--root <repository>]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere. PR_LABELS holds the pull
// request's label names as a JSON list; none when it is unset.

const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: "string" } } });
const root = values.root === undefined ? fileURLToPath(new URL("../../../", import.meta.url)) : resolve(values.root);
const baseRef = positionals[0] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const mergeBase = git("merge-base", baseRef, "HEAD").trim();
let base: string | undefined;
try {
  base = git("show", `${mergeBase}:pnpm-workspace.yaml`);
} catch {
  base = undefined;
}
const problems = releaseAgeLabelProblems({
  base: exclusionsIn(base),
  revision: exclusionsIn(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
  labels: parseLabels(process.env["PR_LABELS"]),
});
if (problems.length === 0) {
  console.log(`pnpm-workspace.yaml adds no exclusion from the release age against the merge base ${mergeBase.slice(0, 12)}, or the pull request carries the label.`);
} else {
  for (const problem of problems) console.error(problem);
  console.error(
    "A fixable HIGH or CRITICAL finding outside Debian may take the version its advisory names as fixed before it is 7 days old, " +
      "in a reviewed pull request with the release-age-exception label that records the exception in tools/repo-checks/release-age-exceptions.json.",
  );
  process.exitCode = 1;
}
