// CI check of the release's gates (self-host-install: Upgrades apply
// migrations before the app starts; public-api: Each operation carries a
// stability level; self-host-install: Release pipeline integrity; design.md,
// Technical decisions: T13, R-d): the fresh-install, upgrade,
// backup-and-restore, polling-mode and egress tests, the release check of
// stability levels and the vulnerability scan each run in the release
// workflow, or in a workflow of this repository it calls, and a failure in any
// of them stops every job of the release workflow that can push or publish. It
// fails when one of them does not run, or when a job that can write would
// still run after it failed, after its script went on past its failing
// command, or after a condition skipped it; and when the release's scan does
// not run as the Build workflow's scan does, with the same scanner and rules.
// Usage: node tools/repo-checks/src/check-release-gates.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { BUILD_WORKFLOW, gateSites, publishingAfterFailure, publishingAfterSkip, RELEASE_GATES, RELEASE_WORKFLOW, releaseGateProblems } from "./release-gates.ts";

const root = resolve(process.argv[2] ?? ".");
const problems = releaseGateProblems(root);
for (const gate of RELEASE_GATES) {
  for (const site of gateSites(root, gate)) {
    if (publishingAfterFailure(root, site).length === 0 && publishingAfterSkip(root, site).length === 0) {
      console.log(`${gate.name} runs in ${site.file}#${site.job}; when it fails, no job that pushes or publishes runs.`);
    }
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    `\nA release is published only after these gates pass on its image and documents: every job of ${RELEASE_WORKFLOW} that can push or ` +
      "publish must need, directly or through jobs that run only when theirs succeeded, each job that runs a gate, and no gate may continue on error. " +
      `The vulnerability scan runs as the Build workflow's scan in ${BUILD_WORKFLOW} does, with the Build workflow's scanner and rules.`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nEvery gate stops the release when it fails: no job of ${RELEASE_WORKFLOW} that can push or publish runs after it.`);
}
