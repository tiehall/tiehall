import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_BREAKING_LABEL } from "@tiehall/catalog/changelog";
import { parseLabels } from "./api-compat.ts";
import { checkToolPullRequest, readToolPullRequest, recordedLevels, TOOL_SNAPSHOT } from "./tool-compat.ts";

// CI's tool compatibility check on a pull request (public-api: MCP tools follow
// the same compatibility rules): it compares mcp/tools.json at the pull
// request's merge base with the pull request's, through the pinned oasdiff, by
// the notice rules of each tool's operation, and applies the api-breaking
// label's rule with openapi/changelog.json at both. `pnpm check:mcp-tools`
// has already checked that the pull request's snapshot is what its catalog
// generates.
// Usage: node tools/repo-checks/src/check-tool-compat.ts [base-ref] [repository]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere; the repository to this one.
// PR_LABELS holds the pull request's label names as a JSON list; none when it
// is unset.

const root = process.argv[3] === undefined ? fileURLToPath(new URL("../../../", import.meta.url)) : resolve(process.argv[3]);
const baseRef = process.argv[2] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const labels = parseLabels(process.env["PR_LABELS"]);

const files = readToolPullRequest(root, baseRef);
const at = files.mergeBase.slice(0, 12);
if (files.base === undefined) {
  console.log(`${TOOL_SNAPSHOT} does not exist at the merge base ${at}, so there is nothing to compare.`);
  process.exit(0);
}
const result = await checkToolPullRequest({
  base: files.base,
  revision: files.revision,
  labels,
  ...(files.changelogBase === undefined ? {} : { changelogBase: files.changelogBase }),
  changelogRevision: files.changelogRevision,
});
const levels = recordedLevels(files.base);
const findings = result.errors.map(({ id, text, operationId }) => {
  const tool = operationId === undefined ? "" : `${operationId} (${levels.get(operationId) ?? "new"}): `;
  return `- ${tool}${text} [${id}]`;
});
if (result.passed && result.errors.length === 0) {
  console.log(`${TOOL_SNAPSHOT} keeps the notice rules against the merge base ${at}.`);
} else if (result.passed) {
  console.log(`${TOOL_SNAPSHOT} breaks the notice rules against the merge base ${at}, as the ${API_BREAKING_LABEL} label allows:`);
  for (const line of findings) console.log(line);
  console.log("The pull request adds a breaking changelog entry, as the label needs.");
} else {
  if (result.errors.length > 0) {
    console.error(`${TOOL_SNAPSHOT} breaks the notice rules against the merge base ${at}:`);
    for (const line of findings) console.error(line);
  }
  for (const problem of result.problems) console.error(problem);
  if (result.errors.length > 0 && !result.labelled) {
    console.error(
      "A tool follows the notice rules of its operation. A beta tool is removed, or gains a required argument, in three steps: " +
        "add the new shape, deprecate the old one with a sunset at least 14 days later, and remove it on or after that date. " +
        "A stable tool only gains things: a breaking change ships under a new tool name, and the old tool stays until a sunset " +
        `at least 180 days later. Only an urgent security fix may skip the notice, with the ${API_BREAKING_LABEL} label and a ` +
        "changelog entry of kind breaking in openapi/changelog.json.",
    );
  }
  process.exitCode = 1;
}
