// Renders a page to a PNG in the installed Chrome, which playwright-core
// already drives for the browser tests: the install's icons (write-icons.ts)
// and the brand's images (write-brand.ts). TIEHALL_TEST_CHROME names another
// Chromium-based browser, as for the browser tests. Each page is drawn in
// sRGB and in software, whatever the machine's display and graphics card, so
// that each run draws the same pixels.
import { chromium, type Browser } from "playwright-core";

/** Runs this work with a browser of its own, closed afterwards. */
export async function withChrome<T>(work: (browser: Browser) => Promise<T>): Promise<T> {
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  const args = ["--force-color-profile=srgb", "--disable-gpu", "--disable-lcd-text"];
  const browser = await chromium.launch(executablePath === undefined ? { channel: "chrome", args } : { executablePath, args });
  try {
    return await work(browser);
  } finally {
    await browser.close();
  }
}

/** What to render: the body's markup and the page's own style rules, at exactly this size. */
export interface PngPage {
  body: string;
  css?: string;
  width: number;
  height: number;
}

/**
 * The page rendered as a PNG of exactly its size, in a viewport of its own of
 * that size at one device pixel per CSS pixel, with no margin around the body
 * and a transparent background wherever the page draws none.
 */
export async function renderPng(browser: Browser, { body, css = "", width, height }: PngPage): Promise<Uint8Array> {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}${css}</style></head><body>${body}</body></html>`,
    );
    // The fonts, then two frames, so the page has drawn everything; strings, since the package's types know no DOM.
    await page.evaluate("document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    return new Uint8Array(await page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width, height } }));
  } finally {
    await context.close();
  }
}
