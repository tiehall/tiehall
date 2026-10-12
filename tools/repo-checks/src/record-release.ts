import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { recordRelease, releaseNotes } from "./api-changelog.ts";

// Records a release's API changes in openapi/changelog.json and writes the
// API section of its notes (public-api: The changelog page and the release
// notes): the pinned oasdiff's changelog of openapi/v1.json from the previous
// release's tag to the working tree, with the unreleased entries. It runs
// when a release is prepared, before its tag, so the image built from the tag
// carries the record.
// Usage: node tools/repo-checks/src/record-release.ts <version> [--previous <git ref>] [--date YYYY-MM-DD] [--notes <file>]
// Without --previous, the release is the first one and every operation is
// listed as added. The notes go to standard output unless --notes names a file.
// A release candidate gets no record of its own, so the version is a final
// release's: its record collects every change and entry for its candidates too
// (design.md, Technical decisions: T13, R-e).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { previous: { type: "string" }, date: { type: "string" }, notes: { type: "string" } },
});
const [version] = positionals;
if (version === undefined || positionals.length !== 1) {
  console.error("Usage: node tools/repo-checks/src/record-release.ts <version> [--previous <git ref>] [--date YYYY-MM-DD] [--notes <file>]");
  process.exit(2);
}
const changelogFile = `${root}openapi/changelog.json`;
const previousDocument =
  values.previous === undefined
    ? undefined
    : execFileSync("git", ["show", `${values.previous}:openapi/v1.json`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const { changelog, release } = await recordRelease({
  changelog: readFileSync(changelogFile, "utf8"),
  version,
  date: values.date ?? new Date().toISOString().slice(0, 10),
  ...(previousDocument === undefined ? {} : { previousDocument }),
  document: readFileSync(`${root}openapi/v1.json`, "utf8"),
});
writeFileSync(changelogFile, changelog);
const notes = releaseNotes(release);
if (values.notes === undefined) process.stdout.write(notes);
else writeFileSync(values.notes, notes);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
console.error(`Recorded release ${version} in openapi/changelog.json: ${count(release.entries.length, "entry")}`.replace("entrys", "entries") + ` and ${count(release.changes.length, "change")}.`);
