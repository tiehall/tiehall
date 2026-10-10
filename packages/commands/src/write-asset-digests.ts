// Writes packages/commands/src/asset-digests.ts, the committed table of the
// digests by which pages name the install's assets, from the files in
// packages/commands/assets/ as the asset route serves them (web-ui: The
// install serves its own assets; design.md, Design: The install's assets; D57
// (14)). Run `pnpm assets:digests` after changing an asset; a test recomputes
// the table and fails on any difference.
// Usage: node packages/commands/src/write-asset-digests.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeAssetDigests } from "./assets.ts";

const folder = fileURLToPath(new URL("../assets/", import.meta.url));
const target = fileURLToPath(new URL("./asset-digests.ts", import.meta.url));
const digests = await computeAssetDigests(folder);

writeFileSync(
  target,
  [
    "// The digest of each asset the install serves, by its path, as the asset route serves it (assets.ts). Written by",
    "// `pnpm assets:digests` (write-asset-digests.ts) from packages/commands/assets/; do not edit it by hand.",
    "export const ASSET_DIGESTS: Readonly<Record<string, string>> = {",
    ...Object.entries(digests).map(([path, digest]) => `  ${JSON.stringify(path)}: ${JSON.stringify(digest)},`),
    "};",
    "",
  ].join("\n"),
);
console.log(`Wrote the digests of ${Object.keys(digests).length} assets to packages/commands/src/asset-digests.ts.`);
