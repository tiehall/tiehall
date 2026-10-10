// Copies the files a release publishes beside its image into a folder, under
// the names the release page gives them, for the release workflow to upload
// (self-host-install: Releases carry signed attestations): compose.yaml, the
// Caddyfile, .env.example as env.example, backup.sh and restore.sh, and with
// --notes the release notes from the folder the notes artifact was downloaded
// into, which must hold release-notes.md alone, as a regular file. The folder
// must be new or empty, so it holds only what was staged.
// Usage: node tools/repo-checks/src/stage-release-files.ts <folder> [--notes <folder>] [--root <repository>]
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { stageReleaseFiles } from "./release-files.ts";

const usage = "Usage: node tools/repo-checks/src/stage-release-files.ts <folder> [--notes <folder>] [--root <repository>]";
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { root: { type: "string", default: "." }, notes: { type: "string" } } });
} catch {
  console.error(usage);
  process.exit(2);
}
const { values, positionals } = parsed;
const [folder] = positionals;
if (folder === undefined || positionals.length !== 1) {
  console.error(usage);
  process.exit(2);
}
try {
  const staged = stageReleaseFiles(resolve(values.root), resolve(folder), values.notes === undefined ? undefined : resolve(values.notes));
  console.log(`Staged ${staged.length} release files in ${folder}.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
