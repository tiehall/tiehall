// Reads the release a version tag makes, for the release workflow
// (self-host-install: Releases carry signed attestations): it refuses a tag
// that names no semantic version and a tag whose commit is not on main, and
// prints the release's version, whether it is a release candidate, and the
// tag of the previous release, as lines name=value, into $GITHUB_OUTPUT when
// it is set, and on standard output otherwise.
// Usage: node tools/repo-checks/src/read-release-tag.ts <tag> [--main <ref>] [--root <folder>]
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { releaseOf } from "./release-tag.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { main: { type: "string", default: "origin/main" }, root: { type: "string", default: "." } },
});
const [tag] = positionals;
if (tag === undefined || positionals.length !== 1) {
  console.error("Usage: node tools/repo-checks/src/read-release-tag.ts <tag> [--main <ref>] [--root <folder>]");
  process.exit(2);
}
try {
  const release = releaseOf(resolve(values.root), tag, values.main);
  const lines = `version=${release.version}\nprerelease=${release.prerelease}\nprevious=${release.previous ?? ""}\n`;
  const output = process.env["GITHUB_OUTPUT"];
  if (output === undefined || output === "") process.stdout.write(lines);
  else appendFileSync(output, lines);
  console.error(
    `Release ${release.version}${release.prerelease ? ", a release candidate," : ""} from ${tag}; ` +
      (release.previous === undefined ? "it is the first release." : `the previous release is ${release.previous}.`),
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
