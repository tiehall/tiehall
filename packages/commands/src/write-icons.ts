// Writes the install's icons to packages/commands/assets/ (web-ui: The mark,
// the favicon and the app icon; design.md, Design: The mark and the icons;
// D57 (2), (10); D59 (3)): icon.svg, the mark in gold on a navy rounded
// square; the PNG icons, rendered in the installed Chrome, which
// playwright-core already drives for the browser tests, each with the stroke
// of the size its mark is drawn at; and favicon.ico, which holds the PNG
// images of 16, 32 and 48 pixels, packed by the small writer below: an ICO
// file is a header and a directory of images. The files are committed; `pnpm icons:generate` runs this
// and then writes the assets' digests again. TIEHALL_TEST_CHROME names another
// Chromium-based browser, as for the browser tests.
// Usage: node packages/commands/src/write-icons.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { FAVICON_SIDES, ICON_SVG_SIDE, ICONS, iconSvg } from "./mark.ts";

const folder = fileURLToPath(new URL("../assets/", import.meta.url));

/**
 * The icon at this side, rendered as a PNG with a transparent background
 * around its rounded corners, in a page of its own of exactly that size, so
 * that each run draws the same pixels.
 */
async function render(browser: Browser, side: number, rounded: boolean): Promise<Uint8Array> {
  const context = await browser.newContext({ viewport: { width: side, height: side }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${iconSvg(side, { rounded })}</body></html>`);
    await page.addStyleTag({ content: "html,body{margin:0;padding:0;background:transparent}svg{display:block}" });
    // Two frames, so the page has drawn the icon; a string, since the package's types know no DOM.
    await page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    return new Uint8Array(await page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: side, height: side } }));
  } finally {
    await context.close();
  }
}

/** An ICO file that holds these PNG images: the header, one directory entry per image, then the images. */
function ico(images: readonly { side: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + 16 * images.length;
  const bytes = new Uint8Array(header + images.reduce((total, { png }) => total + png.byteLength, 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = header;
  images.forEach(({ side, png }, index) => {
    const entry = 6 + 16 * index;
    bytes[entry] = side >= 256 ? 0 : side;
    bytes[entry + 1] = side >= 256 ? 0 : side;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    bytes.set(png, offset);
    offset += png.byteLength;
  });
  return bytes;
}

writeFileSync(`${folder}icon.svg`, `${iconSvg(ICON_SVG_SIDE)}\n`);
const executablePath = process.env["TIEHALL_TEST_CHROME"];
// Drawn in sRGB and in software, whatever the machine's display and graphics card.
const args = ["--force-color-profile=srgb", "--disable-gpu", "--disable-lcd-text"];
const browser = await chromium.launch(executablePath === undefined ? { channel: "chrome", args } : { executablePath, args });
try {
  for (const { file, side, rounded } of ICONS) writeFileSync(`${folder}${file}`, await render(browser, side, rounded));
  const favicons = [];
  for (const side of FAVICON_SIDES) favicons.push({ side, png: await render(browser, side, true) });
  writeFileSync(`${folder}favicon.ico`, ico(favicons));
} finally {
  await browser.close();
}
console.log(`Wrote icon.svg, ${ICONS.map(({ file }) => file).join(", ")} and favicon.ico to packages/commands/assets/.`);
