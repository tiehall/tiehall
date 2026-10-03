// Release check: fails when the release's committed OpenAPI documents or its
// MCP tool list offer an operation or a tool at alpha, or an operation without
// a stability level (public-api: Each operation carries a stability level).
// The release job runs it before anything is published; between releases
// alpha is allowed, so it does not run on every pull request.
// Usage: node tools/repo-checks/src/check-release-stability.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { releaseStabilityProblems } from "./release-stability.ts";

const root = resolve(process.argv[2] ?? ".");
const problems = releaseStabilityProblems(root);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    "\nA published release offers no operation or tool at alpha, so every operation a company can call is held to the notice rules. " +
      "Move it to beta, or leave it out of the release.\n",
  );
  process.exitCode = 1;
} else {
  console.log("No operation of openapi/v1.json and no tool of mcp/tools.json is at alpha, and every operation carries a stability level.");
}
