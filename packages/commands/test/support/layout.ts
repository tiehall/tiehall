import type { Page } from "playwright-core";

// What a page looks like at phone width, read in the browser (web-ui: Pages
// work at phone width; web-ui: Pages are accessible; design.md, Design: Phone
// width; D57 (7), (8)): whether the page is wider than its viewport, and every
// control the page shows that is smaller than 24 by 24 CSS pixels, apart from
// a link inside a sentence or a block of text, which WCAG 2.2's success
// criterion 2.5.8 exempts. A control that is not shown, such as one in a menu
// that is closed or the skip link before it has the focus, is left out.

/**
 * What the browser runs to find the problems: plain JavaScript, as a string,
 * since this package's types hold no browser's (as the other browser tests
 * read the page, with a string).
 */
const PHONE_WIDTH_CHECK = `(tablesScroll) => {
  const problems = [];
  const viewport = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewport) problems.push("the page is " + document.documentElement.scrollWidth + " CSS pixels wide in a viewport of " + viewport);
  const describe = (element) => element.tagName.toLowerCase() + ' "' + ((element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40) || element.getAttribute("name") || element.id) + '"';
  for (const element of document.querySelectorAll("main *")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= viewport + 0.5) continue;
    let scroller = element.parentElement;
    let inside = false;
    while (scroller !== null && scroller !== document.body) {
      const overflow = getComputedStyle(scroller).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && (tablesScroll || scroller.tagName !== "TABLE")) inside = true;
      scroller = scroller.parentElement;
    }
    if (!inside) problems.push(describe(element) + " reaches " + Math.round(rect.right) + " CSS pixels, past the viewport");
  }
  const inText = (element) => {
    if (element.tagName !== "A" || getComputedStyle(element).display !== "inline") return false;
    let block = element.parentElement;
    while (block !== null && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    const all = ((block && block.textContent) || "").replace(/\\s+/g, "");
    return all.length > (element.textContent || "").replace(/\\s+/g, "").length;
  };
  for (const element of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || getComputedStyle(element).visibility === "hidden") continue;
    if (inText(element)) continue;
    if (rect.width < 24 || rect.height < 24) problems.push(describe(element) + " is " + Math.round(rect.width) + " by " + Math.round(rect.height) + " CSS pixels");
  }
  return problems;
}`;

/** The ways the page breaks the rules of phone width, as sentences; none when it keeps them. A table may scroll inside its own box when the options say so. */
export async function phoneWidthProblems(page: Page, options: { tablesScroll?: boolean } = {}): Promise<string[]> {
  return (await page.evaluate(`(${PHONE_WIDTH_CHECK})(${JSON.stringify(options.tablesScroll === true)})`)) as string[];
}

/**
 * Waits until the page shown has settled: until the network is idle, or, on
 * the live hall, whose long-poll always holds a read open, until its script
 * says the page is live (web-ui: The live hall's reads and its long-poll).
 */
export async function settled(page: Page): Promise<void> {
  if (new URL(page.url()).pathname === "/hall") await page.locator("#live-words", { hasText: /^Live$/ }).waitFor();
  else await page.waitForLoadState("networkidle");
}

/** The names of the animations running on the page now. */
export async function runningAnimations(page: Page): Promise<string[]> {
  return (await page.evaluate('document.getAnimations().filter((animation) => animation.playState === "running").map((animation) => animation.animationName ?? "a transition")')) as string[];
}
