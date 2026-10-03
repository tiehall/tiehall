// CI check for public-api: One error model for Tiehall's own refusals. It
// fails when a row of the error model has no test on REST, or names no test
// on MCP where tool errors apply and says not why they do not, when a named
// test does not exist or does not run, when its file never names the row, and
// when a test on MCP does not read a tool error. `pnpm test` runs the named
// tests; this check makes sure each row has them.
// Usage: node tools/repo-checks/src/check-error-model.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { REFUSAL_REASONS } from "@tiehall/core";
import { ERROR_MODEL_TEST_LIST, errorModelCoverageProblems, readErrorModelInputs } from "./error-model-coverage.ts";

const root = resolve(process.argv[2] ?? ".");
const rows = Object.keys(REFUSAL_REASONS);
const problems = errorModelCoverageProblems(readErrorModelInputs(root, rows));

if (problems.length === 0) {
  console.log(`${ERROR_MODEL_TEST_LIST} names a test on REST of each of the ${rows.length} rows of the error model, and its test on MCP or why tool errors do not apply to it.`);
} else {
  for (const problem of problems) console.error(problem);
  console.error(
    `\nEvery row of the error model names, in ${ERROR_MODEL_TEST_LIST}, its test on REST and its test on MCP, ` +
      "or why the surface does not reach it, before a task that makes it reachable is checked off.",
  );
  process.exitCode = 1;
}
