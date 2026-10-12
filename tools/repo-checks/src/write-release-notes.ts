// Writes a release's notes for the release workflow (self-host-install:
// Releases carry signed attestations; public-api: The changelog page and the
// release notes; self-host-install: Migrations expand, then contract;
// self-host-install: Upgrades apply migrations before the app starts), from
// the image it pushed, pinned by version and digest, the repository's web
// address, and the repository at the release's tag: the API changes
// openapi/changelog.json records for the release, the contract steps it adds
// since the previous release's tag, and the releases release/no-skip.json
// names. The notes go to standard output unless --output names a file. With
// --check and no image, it only checks, before the image is built, that the
// notes can be written, and says what they will hold. The notes pin the
// contract Action by --commit, the commit the release's tag points to, and
// name the Claude Code plugin the repository's marketplace lists, which
// --check checks too.
// Usage: node tools/repo-checks/src/write-release-notes.ts <version> [--previous <tag>] (--image <repository>:<version>@sha256:<digest> --repository <web address> --commit <sha> [--output <file>] | --check) [--root <repository>]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { parseReleaseCommit, parseReleaseImage, releasePlugin, renderReleaseNotes, repositoryName } from "./release-notes.ts";
import { releaseSources } from "./release-sources.ts";

const USAGE =
  "Usage: node tools/repo-checks/src/write-release-notes.ts <version> [--previous <tag>] " +
  "(--image <repository>:<version>@sha256:<digest> --repository <web address> --commit <sha> [--output <file>] | --check) [--root <repository>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    previous: { type: "string" },
    image: { type: "string" },
    repository: { type: "string" },
    commit: { type: "string" },
    output: { type: "string" },
    check: { type: "boolean", default: false },
    root: { type: "string", default: "." },
  },
});
const [version] = positionals;
const writing = values.image !== undefined && values.repository !== undefined && values.commit !== undefined;
if (
  version === undefined ||
  positionals.length !== 1 ||
  (values.check ? values.image !== undefined || values.output !== undefined || values.commit !== undefined : !writing)
) {
  console.error(USAGE);
  process.exit(2);
}
/** A count with its noun, such as 1 entry or 2 entries. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
try {
  const image = values.check ? undefined : parseReleaseImage(values.image as string, version);
  if (!values.check) repositoryName(values.repository as string);
  const commit = values.check ? undefined : parseReleaseCommit(values.commit as string);
  // The workflow passes an empty value for the first release, which has no previous release.
  const previous = values.previous === undefined || values.previous === "" ? undefined : values.previous;
  const sources = releaseSources(resolve(values.root), version, previous);
  const plugin = releasePlugin(resolve(values.root));
  if (image === undefined || commit === undefined) {
    const { api } = sources;
    const changes =
      "final" in api
        ? `its API changes are recorded under ${api.final}, with ${count(api.entries.length, "entry that waits", "entries that wait")} for it`
        : `${count(api.changes.length, "API change", "API changes")} and ${count(api.entries.length, "entry", "entries")}` +
          (api.version === version ? "" : `, recorded for ${api.version}`);
    console.log(
      `The notes of ${version} can be written: ${changes}, ${count(sources.contractSteps.length, "contract step", "contract steps")}, ` +
        `${count(sources.noSkip.length, "release that must not be skipped", "releases that must not be skipped")}.`,
    );
  } else {
    const notes = renderReleaseNotes({ root: resolve(values.root), version, image, repository: values.repository as string, commit, plugin, ...sources });
    if (values.output === undefined) process.stdout.write(notes);
    else writeFileSync(values.output, notes);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
