// CI check for self-host-install: Release pipeline integrity. It fails when a
// workflow references an action by tag or branch, when a workflow or job does not
// declare its token permissions, when a job holds a write permission or a
// secret that .github/workflow-policy.json does not list, when a job that holds
// a write permission runs a step that is not first-party, when CI installs
// without the frozen lockfile or with npm install scripts, or when pnpm would
// run install scripts outside the allowlist in pnpm-workspace.yaml.
// Usage: node tools/repo-checks/src/check-workflows.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { checkWorkflows, describePermissions, jobPermissions } from "./workflows.ts";

const root = resolve(process.argv[2] ?? ".");

const rows = jobPermissions(root);
const width = Math.max(0, ...rows.map((row) => row.job.length));
console.log("Token permissions by job:");
for (const { job, permissions } of rows) console.log(`  ${job.padEnd(width)}  ${describePermissions(permissions)}`);

const violations = checkWorkflows(root);
if (violations.length === 0) {
  console.log(
    "\nEvery action is pinned to a commit SHA, every job declares its permissions, the jobs that can write run only first-party steps, " +
      "and installs are safe.",
  );
} else {
  for (const { rule, file, job, detail } of violations) {
    console.error(`${file}${job === undefined ? "" : `#${job}`}: [${rule}] ${detail}`);
  }
  console.error(
    "\nSee self-host-install: Release pipeline integrity. Write permissions and secrets are allowed only for the jobs " +
      "listed in .github/workflow-policy.json.",
  );
  process.exitCode = 1;
}
