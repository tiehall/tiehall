import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { wrappedCells } from "./support/layout.ts";
import { seedInventory } from "./support/page-inventory.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The shell in a browser (web-ui: The page shell and its navigation; web-ui:
// Pages work at phone width; web-ui: Pages are accessible; design.md, Design:
// The page shell and navigation; D57 (4), (7), (8)). In a viewport narrower
// than 768 CSS pixels the navigation, New request and the member's menu fold
// into one menu, which opens without script and holds every link and the
// sign-out form; and the first element the keyboard reaches is the link that
// skips to the page's main content.

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let browser: Browser;
let session = "";

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  await seedInventory(install, stub);
  web = await startWebApp(install);
  const pair = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
  session = pair.slice("tiehall.session_token=".length);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await install?.close();
  await stub?.close();
}, 300_000);

/** A signed-in context of Pia, an admin, with this viewport, with scripts on or off. */
async function signedIn(width: number, javaScriptEnabled: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 780 }, javaScriptEnabled });
  await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
  return context;
}

describe("the shell", () => {
  it("folds the navigation into one menu at 360 CSS pixels, which opens without script and holds every link", { timeout: 120_000 }, async () => {
    const context = await signedIn(360, false);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/inbox`);
    const header = page.locator("header");
    // The wide navigation is hidden; the folded menu is shown, closed.
    await expect(header.locator("nav.nav").isVisible()).resolves.toBe(false);
    const menu = header.locator("details.menu-all");
    await expect(menu.isVisible()).resolves.toBe(true);
    await expect(menu.locator(".menu-panel").isVisible()).resolves.toBe(false);
    await menu.locator("summary").click();
    for (const name of ["Live hall", "Inbox", "Requests", "Members", "Admin", "New request", "Email settings", "Connected agents and tokens"]) {
      await expect(menu.getByRole("link", { name, exact: false }).first().isVisible(), name).resolves.toBe(true);
    }
    await expect(menu.getByRole("button", { name: "Sign out" }).isVisible()).resolves.toBe(true);
    await context.close();
  });

  it("shows the navigation, New request and the member's menu on a wide screen, the menu opening without script", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280, false);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/requests`);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.isVisible()).resolves.toBe(true);
    await expect(nav.getByRole("link", { name: "Requests" }).getAttribute("aria-current")).resolves.toBe("page");
    await expect(page.locator("details.menu-all").isVisible()).resolves.toBe(false);
    const menu = page.locator("header details.menu").first();
    await menu.locator("summary").click();
    await expect(menu.getByRole("link", { name: "Email settings" }).isVisible()).resolves.toBe(true);
    await expect(menu.getByRole("button", { name: "Sign out" }).isVisible()).resolves.toBe(true);
    await context.close();
  });

  it.each([768, 790, 900, 1024])(
    "keeps an admin's top bar on one line at %i CSS pixels: New request's words together, nothing past the viewport, and the member's menu named by the login",
    { timeout: 120_000 },
    async (width) => {
      const context = await signedIn(width, false);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}/inbox`);
      const bar = page.locator("header .topbar-inner");
      await expect(bar.getByRole("link", { name: "New request" }).isVisible()).resolves.toBe(true);
      expect(await wrappedCells(page, "header .topbar-wide a.button, header .topbar-wide nav a")).toEqual([]);
      const past = await bar.evaluate((inner) => {
        const viewport = inner.ownerDocument.documentElement.clientWidth;
        return [...inner.querySelectorAll("*")].filter((each) => each.getBoundingClientRect().width > 0 && each.getBoundingClientRect().right > viewport + 0.5).map((each) => each.outerHTML.slice(0, 80));
      });
      expect(past).toEqual([]);
      await expect(page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).resolves.toBe(true);
      await expect(page.locator("header .topbar-wide details.menu > summary").textContent()).resolves.toContain("pia");
      await context.close();
    },
  );

  it("puts the link that skips to the main content first in the keyboard's order", { timeout: 120_000 }, async () => {
    const context = await signedIn(1280, true);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/inbox`);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused.textContent()).resolves.toBe("Skip to content");
    await expect(focused.getAttribute("href")).resolves.toBe("#content");
    await expect(focused.isVisible()).resolves.toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("main#content").count()).resolves.toBe(1);
    await context.close();
  });
});
