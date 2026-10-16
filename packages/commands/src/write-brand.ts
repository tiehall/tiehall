// Writes the brand's images to docs/assets/brand/ (task 30.10; design.md,
// Decisions this change rests on: D38): the SVG files as brand.ts draws them
// from the mark's source, and the PNG images rendered from its pages in the
// installed Chrome (chrome-png.ts). The files are committed; `pnpm
// brand:generate` runs this after a change to the mark or to the brand's
// images, as `pnpm icons:generate` does for the install's icons.
// Usage: node packages/commands/src/write-brand.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAND_IMAGES, BRAND_SVGS } from "./brand.ts";
import { renderPng, withChrome } from "./chrome-png.ts";

const folder = fileURLToPath(new URL("../../../docs/assets/brand/", import.meta.url));
mkdirSync(folder, { recursive: true });
for (const [file, svg] of Object.entries(BRAND_SVGS)) writeFileSync(`${folder}${file}`, `${svg}\n`);
await withChrome(async (browser) => {
  for (const image of BRAND_IMAGES) writeFileSync(`${folder}${image.file}`, await renderPng(browser, image));
});
console.log(`Wrote ${[...Object.keys(BRAND_SVGS), ...BRAND_IMAGES.map(({ file }) => file)].join(", ")} to docs/assets/brand/.`);
