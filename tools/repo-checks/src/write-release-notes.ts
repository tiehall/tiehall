// Writes a release's notes for the release workflow (self-host-install:
// Releases carry signed attestations), from the image it pushed, pinned by
// version and digest, and the repository's web address. The notes go to
// standard output unless --output names a file.
// Usage: node tools/repo-checks/src/write-release-notes.ts <version> --image <repository>:<version>@sha256:<digest> --repository <web address> [--output <file>] [--root <repository>]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { parseReleaseImage, renderReleaseNotes, repositoryName } from "./release-notes.ts";

const USAGE =
  "Usage: node tools/repo-checks/src/write-release-notes.ts <version> --image <repository>:<version>@sha256:<digest> " +
  "--repository <web address> [--output <file>] [--root <repository>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    image: { type: "string" },
    repository: { type: "string" },
    output: { type: "string" },
    root: { type: "string", default: "." },
  },
});
const [version] = positionals;
if (version === undefined || positionals.length !== 1 || values.image === undefined || values.repository === undefined) {
  console.error(USAGE);
  process.exit(2);
}
try {
  repositoryName(values.repository);
  const notes = renderReleaseNotes({ root: resolve(values.root), version, image: parseReleaseImage(values.image, version), repository: values.repository });
  if (values.output === undefined) process.stdout.write(notes);
  else writeFileSync(values.output, notes);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
