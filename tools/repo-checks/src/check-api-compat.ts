import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { API_BREAKING_LABEL } from "@tiehall/catalog/changelog";
import { checkPullRequest, parseLabels } from "./api-compat.ts";

// CI's compatibility check on a pull request (public-api: Notice before a
// breaking change is enforced in CI; public-api: The `api-breaking` label for
// urgent security fixes): it compares openapi/v1.json at the pull request's
// merge base with the pull request's, through the pinned oasdiff, and applies
// the api-breaking label's rule with openapi/changelog.json at both.
// Usage: node tools/repo-checks/src/check-api-compat.ts [base-ref]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere. PR_LABELS holds the pull request's
// label names as a JSON list; none when it is unset.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseRef = process.argv[2] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const labels = parseLabels(process.env["PR_LABELS"]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const atMergeBase = (file: string): string | undefined => {
  try {
    return git("show", `${mergeBase}:${file}`);
  } catch {
    return undefined;
  }
};

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
const at = mergeBase.slice(0, 12);
const base = atMergeBase("openapi/v1.json");
if (base === undefined) {
  console.log(`openapi/v1.json does not exist at the merge base ${at}, so there is nothing to compare.`);
  process.exit(0);
}
const changelogBase = atMergeBase("openapi/changelog.json");
const result = await checkPullRequest({
  base,
  revision: readFileSync(`${root}openapi/v1.json`, "utf8"),
  labels,
  ...(changelogBase === undefined ? {} : { changelogBase }),
  changelogRevision: readFileSync(`${root}openapi/changelog.json`, "utf8"),
});
const findings = result.errors.map(({ id, text, operationId }) => `- ${operationId === undefined ? "" : `${operationId}: `}${text} [${id}]`);
if (result.passed && result.errors.length === 0) {
  console.log(`openapi/v1.json keeps the notice rules against the merge base ${at}.`);
} else if (result.passed) {
  console.log(`openapi/v1.json breaks the notice rules against the merge base ${at}, as the ${API_BREAKING_LABEL} label allows:`);
  for (const line of findings) console.log(line);
  console.log("The pull request adds a breaking changelog entry and bumps info.version, as the label needs.");
} else {
  if (result.errors.length > 0) {
    console.error(`openapi/v1.json breaks the notice rules against the merge base ${at}:`);
    for (const line of findings) console.error(line);
  }
  for (const problem of result.problems) console.error(problem);
  if (result.errors.length > 0 && !result.labelled) {
    console.error(
      "A beta operation changes in three steps: add the new shape, deprecate the old one with an x-sunset at least 14 days later " +
        "(180 for a stable one), and remove it on or after that date; every breaking change bumps info.version. " +
        `Only an urgent security fix may skip the notice, with the ${API_BREAKING_LABEL} label, a changelog entry of kind breaking ` +
        "in openapi/changelog.json and a bump of info.version.",
    );
  }
  process.exitCode = 1;
}
