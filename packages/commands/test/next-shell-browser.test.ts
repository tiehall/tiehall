import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { assetUrl } from "../src/assets.ts";
import { startErrorPageApp, type ErrorPageApp } from "./support/error-page-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { NO_SUCH_PAGE, seedInventory } from "./support/page-inventory.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The shell of the pages Next.js renders (web-ui: The page shell and its
// navigation; web-ui: One stylesheet with named design tokens; web-ui: The
// content security policy of each kind of page; design.md, Design: The page
// shell and navigation; D57 (4), (9)), in the web app as the image runs it:
// a request's page and a team's intake page take the app shell, and the page
// for a path no route serves and the page shown when a page fails while it
// renders take the focused shell, with no navigation. Each links the install's
// stylesheet and icons, is served with no style element or attribute, and
// breaks none of its policy while its scripts run.

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let errorPage: ErrorPageApp;
let browser: Browser;
let cookie = "";
let session = "";

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  await seedInventory(install, stub);
  web = await startWebApp(install);
  cookie = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header();
  session = (cookie.split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").slice("tiehall.session_token=".length);
  errorPage = await startErrorPageApp(install);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await errorPage?.close();
  await web?.close();
  await install?.close();
  await stub?.close();
}, 300_000);

/** The markup a page is served with, before any script runs. */
async function served(app: { origin: string }, path: string): Promise<{ status: number; html: string }> {
  const answer = await fetch(`${app.origin}${path}`, { headers: { accept: "text/html", cookie } });
  return { status: answer.status, html: await answer.text() };
}

/** Checks the head every page of the web UI carries, and that the page carries no style. */
function expectHeadAndNoStyle(path: string, html: string): void {
  for (const link of [
    `<link rel="stylesheet" href="${assetUrl("/assets/tiehall.css")}"/>`,
    `<link rel="icon" href="${assetUrl("/assets/icon.svg")}" type="image/svg+xml"/>`,
    `<link rel="icon" href="${assetUrl("/favicon.ico")}" sizes="16x16 32x32 48x48"/>`,
    `<link rel="apple-touch-icon" href="${assetUrl("/assets/icon-180.png")}"/>`,
    '<meta name="color-scheme" content="light dark"/>',
  ]) {
    expect(html, `${path}: ${link}`).toContain(link);
  }
  expect(html, path).not.toMatch(/<style\b|\sstyle=/i);
  expect(html, path).toMatch(/<a class="skip" href="#content">Skip to content<\/a>/);
  expect(html.match(/<footer>/g), path).toHaveLength(1);
}

describe("the pages Next.js renders", () => {
  it("serve a request's page and a team's page in the app shell, with the stylesheet, the icons and no style", { timeout: 120_000 }, async () => {
    for (const path of ["/FE-1", "/FE"]) {
      const { status, html } = await served(web, path);
      expect(status, path).toBe(200);
      expectHeadAndNoStyle(path, html);
      expect(html, path).toContain('<nav class="nav" aria-label="Main">');
      expect(html, path).toMatch(/<a href="\/requests" aria-current="page">Requests<\/a>/);
      expect(html, path).toMatch(/<main id="content" class="(request|intake)-page">/);
      expect(html.match(/<h1\b/g), path).toHaveLength(1);
    }
  });

  it("serve the page for a path no route serves in the focused shell, at a path of one segment and of more", { timeout: 120_000 }, async () => {
    for (const path of [NO_SUCH_PAGE, `${NO_SUCH_PAGE}/at-all`]) {
      const page = await served(web, path);
      expect(page.status, path).toBe(404);
      expectHeadAndNoStyle(path, page.html);
      expect(page.html, path).not.toMatch(/<nav\b|<details\b/);
      expect(page.html, path).toContain('<main id="content" class="focused">');
      expect(page.html, path).toMatch(/<span class="brand"><span class="mark">/);
    }
  });

  // Next.js answers a page that fails while it renders with its own document for the browser to recover in, with no
  // markup of the page's own, and the browser then draws the web app's page for a failed render: its stylesheet,
  // icons and focused shell are checked in the page's DOM after its scripts ran.
  it("show the page shown when a page fails in the focused shell, linking the stylesheet and the icons, with no style", { timeout: 120_000 }, async () => {
    const page = await served(errorPage, "/fails/now");
    expect(page.status).toBe(500);
    expect(page.html).not.toMatch(/<style\b|\sstyle=/i);
    const context = await browser.newContext({ colorScheme: "light" });
    const tab = await context.newPage();
    tab.setDefaultTimeout(15_000);
    const answered = new Map<string, number>();
    tab.on("response", (response) => answered.set(new URL(response.url()).pathname, response.status()));
    await tab.goto(`${errorPage.url}/fails/now`);
    await tab.getByRole("heading", { level: 1, name: "Tiehall could not show this page" }).waitFor();
    // The fixture app serves the install's assets as the web app does, so the page is drawn with its stylesheet.
    await expect.poll(() => answered.get("/assets/tiehall.css")).toBe(200);
    await expect.poll(() => tab.locator("body").evaluate((body) => body.ownerDocument.defaultView?.getComputedStyle(body).backgroundColor)).toBe("rgb(246, 247, 249)");
    for (const selector of [
      `link[rel="stylesheet"][href="${assetUrl("/assets/tiehall.css")}"]`,
      `link[rel="icon"][href="${assetUrl("/assets/icon.svg")}"]`,
      `link[rel="icon"][href="${assetUrl("/favicon.ico")}"]`,
      'meta[name="color-scheme"][content="light dark"]',
      "header span.brand span.mark svg",
      "main#content.focused",
      "footer",
    ]) {
      await expect(tab.locator(selector).count(), selector).resolves.toBe(1);
    }
    await expect(tab.locator("nav, details").count()).resolves.toBe(0);
    await context.close();
  });

  it("break none of their policy while their scripts run", { timeout: 120_000 }, async () => {
    for (const [app, path] of [
      [web, "/FE-1"],
      [web, "/FE"],
      [web, NO_SUCH_PAGE],
      [errorPage, "/fails/now"],
    ] as const) {
      const context = await browser.newContext();
      await context.addCookies([{ name: "tiehall.session_token", value: session, url: app.url }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const messages: string[] = [];
      page.on("console", (message) => {
        if (/content security policy|content-security-policy/i.test(message.text())) messages.push(message.text());
      });
      await page.addInitScript({
        content: `window.tiehallViolations = [];
document.addEventListener("securitypolicyviolation", (event) => window.tiehallViolations.push(event.violatedDirective + " " + event.blockedURI));`,
      });
      await page.goto(`${app.url}${path}`);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate("window.tiehallViolations"), path).toEqual([]);
      expect(messages, path).toEqual([]);
      await context.close();
    }
  });
});
