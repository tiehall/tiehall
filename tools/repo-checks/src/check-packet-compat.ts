import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { API_BREAKING_LABEL } from "@tiehall/catalog/changelog";
import { parseLabels } from "./api-compat.ts";
import { checkPacketPullRequest, PACKET_NOTICE_DAYS, type FixtureVersion } from "./packet-compat.ts";

// CI's fixture-compatibility check on a pull request (handoff-packet: Breaking
// packet changes before publication): every version of every valid packet
// fixture up to the pull request's merge base that validates against the
// packet schema there must still validate against the pull request's schema,
// and a valid fixture changes or goes only with the api-breaking label and a
// changelog entry of kind breaking about the packet, dated no earlier than
// today.
// Usage: node tools/repo-checks/src/check-packet-compat.ts [base-ref]
// The base ref defaults to origin/<the pull request's base branch> in CI
// (BASE_REF), and to origin/main elsewhere. PR_LABELS holds the pull request's
// label names as a JSON list; none when it is unset.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const VALID = "packages/packet/fixtures/valid/";
const SCHEMA = "packages/packet/schema/v1-beta.json";
const CHANGELOG = "openapi/changelog.json";
const baseRef = process.argv[2] ?? `origin/${process.env["BASE_REF"] || "main"}`;
const labels = parseLabels(process.env["PR_LABELS"]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const lines = (text: string) => text.split("\n").filter((line) => line !== "");
const show = (ref: string, file: string): string | undefined => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return undefined;
  }
};

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
const at = mergeBase.slice(0, 12);

// Each version of a valid fixture is read from the commit that made it.
const fixturesEver: FixtureVersion[] = [];
for (const commit of lines(git("log", "--format=%H", mergeBase, "--", VALID))) {
  for (const file of lines(git("diff-tree", "-r", "--root", "--no-commit-id", "--name-only", commit, "--", VALID))) {
    const text = file.endsWith(".json") ? show(commit, file) : undefined;
    if (text !== undefined) fixturesEver.push({ name: `valid/${file.slice(VALID.length)}`, text, commit });
  }
}
const validBase = Object.fromEntries(
  lines(git("ls-tree", "-r", "--name-only", mergeBase, "--", VALID))
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`valid/${file.slice(VALID.length)}`, show(mergeBase, file) ?? ""]),
);
const validRevision = existsSync(`${root}${VALID}`)
  ? Object.fromEntries(
      readdirSync(`${root}${VALID}`)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [`valid/${name}`, readFileSync(`${root}${VALID}${name}`, "utf8")]),
    )
  : {};
const schemaBase = show(mergeBase, SCHEMA);
const changelogBase = show(mergeBase, CHANGELOG);

const result = checkPacketPullRequest({
  fixturesEver,
  validBase,
  validRevision,
  ...(schemaBase === undefined ? {} : { schemaBase }),
  schemaRevision: readFileSync(`${root}${SCHEMA}`, "utf8"),
  labels,
  ...(changelogBase === undefined ? {} : { changelogBase }),
  changelogRevision: readFileSync(`${root}${CHANGELOG}`, "utf8"),
  today: new Date().toISOString().slice(0, 10),
});

const breaks = result.breaks.map((line) => `- ${line}`);
if (result.passed && result.breaks.length === 0) {
  console.log(`The packet schema keeps every valid fixture since the merge base ${at} valid, and no valid fixture changes.`);
} else if (result.passed) {
  console.log(`The pull request breaks packet fixtures against the merge base ${at}, as the ${API_BREAKING_LABEL} label and its changelog entry allow:`);
  for (const line of breaks) console.log(line);
  console.log(`No release may contain the change until ${PACKET_NOTICE_DAYS} days after the entry's date.`);
} else {
  if (result.breaks.length > 0) {
    console.error(`The pull request breaks packet fixtures against the merge base ${at}:`);
    for (const line of breaks) console.error(line);
  }
  for (const problem of result.problems) console.error(problem);
  process.exitCode = 1;
}
