// CI's graduation check (public-api: Each operation graduates on its own):
// fails when an operation is marked stable in a committed OpenAPI document or
// in the MCP tool snapshot without a graduation in openapi/changelog.json that
// passed the test, four weeks with no breaking change to it before the
// maintainers' recorded decision; contract.report, with the CI OIDC path, is
// exempt. tools/repo-checks/src/graduation.ts holds the rules.
// Usage: node tools/repo-checks/src/check-graduation.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { graduationProblems, readGraduationTree } from "./graduation.ts";

const root = resolve(process.argv[2] ?? ".");
const today = new Date().toISOString().slice(0, 10);
const problems = graduationProblems({ ...readGraduationTree(root), today });
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    "\nAn operation other than contract.report is stable only once no breaking change to it was needed for four weeks and the maintainers " +
      'have decided to graduate it: add an entry of kind "graduation" that names it to openapi/changelog.json, dated the day they decided, ' +
      "or leave it at beta.\n",
  );
  process.exitCode = 1;
} else {
  console.log("Every stable operation of the OpenAPI documents and mcp/tools.json has passed the graduation test, or is contract.report, which is stable from the start.");
}
