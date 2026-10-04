// Copies the files a release publishes beside its image into a folder, under
// the names the release page gives them, for the release workflow to upload
// (self-host-install: Releases carry signed attestations): compose.yaml, the
// Caddyfile, .env.example as env.example, backup.sh and restore.sh.
// Usage: node tools/repo-checks/src/stage-release-files.ts <folder> [--root <repository>]
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { stageReleaseFiles } from "./release-files.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: "string", default: "." } } });
const [folder] = positionals;
if (folder === undefined || positionals.length !== 1) {
  console.error("Usage: node tools/repo-checks/src/stage-release-files.ts <folder> [--root <repository>]");
  process.exit(2);
}
try {
  const staged = stageReleaseFiles(resolve(values.root), resolve(folder));
  console.log(`Staged ${staged.length} release files in ${folder}.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
