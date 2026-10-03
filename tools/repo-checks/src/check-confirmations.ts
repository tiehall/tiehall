// CI check for agent-safety: Actions that need the confirmation step (and
// agent-safety: The confirmation step runs only in the web UI; agent-surfaces:
// Admin actions and trust changes are on no agent surface). It fails when
// tools/repo-checks/confirmation-actions.json does not mirror the spec's list,
// when an action that a finished task built names no confirm command with an
// input for its two cases, and when a confirm command is offered on REST, the
// CLI or MCP. The commands' tests run the two cases of every built action.
// With --full, it checks against the full list: it also fails each action that
// still waits for the task that builds it (task 26.6).
// Usage: node tools/repo-checks/src/check-confirmations.ts [--full] [root]
import { resolve } from "node:path";
import process from "node:process";
import { CATALOG } from "@tiehall/catalog";
import { builtActions, CONFIRMATION_LIST, confirmationCoverageProblems, readCoverageInputs, REQUIREMENT, type ConfirmationList } from "./confirmation-coverage.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const root = resolve(args.find((arg) => arg !== "--full") ?? ".");
const inputs = readCoverageInputs(root, CATALOG);
const problems = confirmationCoverageProblems(inputs, { full });

if (problems.length === 0) {
  const list = inputs.list as ConfirmationList;
  const actions = list.items.flatMap(({ actions }) => actions).length;
  console.log(
    `${CONFIRMATION_LIST} mirrors the ${list.items.length} items of ${REQUIREMENT}: ${actions} actions, ` +
      (full
        ? "every action names its confirm command with an input for its two cases; "
        : `${builtActions(list).length} built with their confirm commands, the rest waiting for the tasks that build them; `) +
      "no confirm command is offered on REST, the CLI or MCP.",
  );
} else {
  for (const problem of problems) console.error(problem);
  console.error(
    `\nEvery action that needs the confirmation step is listed in ${CONFIRMATION_LIST}, and a task that builds one ` +
      "names its confirm command there, with an input its two cases run with, before it is checked off.",
  );
  process.exitCode = 1;
}
