import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LATEST_V1, readReleaseTree, releasedVersions, releaseHistoryProblems, releaseTreeProblems, releaseUrl, RELEASES_FOLDER } from "./packet-releases.ts";

// CI's check of the packet schema's release-URL tree (handoff-packet: Fixed
// release URLs): packages/packet/releases/ holds v1.0.json and the releases
// after it, each with its URL as $id, and v1.json, which is the latest of them
// byte for byte; and no commit's release file was changed or removed since.
// Before the first release the tree is empty and the check says so.
// Usage: node tools/repo-checks/src/check-packet-releases.ts

const root = fileURLToPath(new URL("../../../", import.meta.url));
const tree = readReleaseTree(join(root, RELEASES_FOLDER));
const problems = [...releaseTreeProblems(tree), ...releaseHistoryProblems(root)];
const released = releasedVersions(tree);

if (problems.length > 0) {
  console.error(`${RELEASES_FOLDER}/ breaks the fixed release URLs:`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    "\nEach published release keeps its file, with its URL as $id, byte for byte, and v1.json is a copy of the latest v1.x release " +
      "(handoff-packet: Fixed release URLs).",
  );
  process.exitCode = 1;
} else if (released.length === 0) {
  console.log(`No release of the packet schema is published yet: ${RELEASES_FOLDER}/ is empty until v1.0, at ${releaseUrl("1.0")}.`);
} else {
  const latest = released.at(-1) ?? "";
  console.log(`${RELEASES_FOLDER}/ publishes ${released.map((version) => `v${version}`).join(", ")}, each as it was first published, and ${LATEST_V1} serves v${latest}.`);
}
