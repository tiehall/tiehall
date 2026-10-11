// CI check for public-api: The license map (design.md, Self-hosting decisions:
// S16). It fails when a client piece of tools/repo-checks/license-map.json is
// not a workspace package or does not say Apache-2.0 in its package.json, or
// when the root or any other workspace package does not say AGPL-3.0; and when
// the root's LICENSE file does not hold the AGPL-3.0 text, or a client piece's
// folder holds no LICENSE file with the Apache-2.0 text.
// Usage: node tools/repo-checks/src/check-licenses.ts [root]
import { resolve } from "node:path";
import process from "node:process";
import { licenseReport, loadLicenseMap } from "./licenses.ts";

const root = resolve(process.argv[2] ?? ".");
const map = loadLicenseMap();
const { violations, packages } = licenseReport(root, map);

if (violations.length === 0) {
  const clientPieces = Object.keys(map.clientPieces).length;
  const others = packages.filter((folder) => folder !== "." && !Object.hasOwn(map.clientPieces, folder)).length;
  console.log(
    `${map.clientLicense} in the ${clientPieces} client pieces of the license map, ` +
      `and ${map.serverLicense} in the root and the ${others} other workspace packages.`,
  );
  console.log(
    `The ${map.serverLicense} text in the root's LICENSE file, ` +
      `and the ${map.clientLicense} text in the LICENSE file of each of the ${clientPieces} client pieces.`,
  );
} else {
  for (const { file, detail } of violations) console.error(`${file}: ${detail}`);
  console.error(
    `\nThe server is ${map.serverLicense} and the client pieces are ${map.clientLicense}, as ` +
      "tools/repo-checks/license-map.json lists them (public-api: The license map). A license, once published, " +
      "cannot be taken back, so changing the map needs a maintainer decision.",
  );
  process.exitCode = 1;
}
