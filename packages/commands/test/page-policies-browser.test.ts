import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startErrorPageApp, type ErrorPageApp } from "./support/error-page-app.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { settled } from "./support/layout.ts";
import { NO_SUCH_PAGE, PAGES, seedInventory, SIGNED_OUT_PAGES } from "./support/page-inventory.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// No page breaks its own policy (web-ui: The content security policy of each
// kind of page; design.md, Design: The content security policy of each kind
// of page; design.md, Design: Testing; D57 (9)). A browser opens every page
// of the inventory, the page for a path no route serves among them, as a
// signed-in admin, as a signed-in member and as a browser with no session, and
// the page shown when a page fails while it renders, through a fixture app
// with the web app's own fallback page, proxy and policy; it collects every
// violation the browser reports, as an event on the page and as a message on
// its console, and fails on any, while each page's scripts run.

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let errorPage: ErrorPageApp;
let browser: Browser;
let confirmPaths: string[];
const cookies = new Map<string, string>();

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  ({ confirmPaths } = await seedInventory(install, stub));
  web = await startWebApp(install);
  const signIn = await startSignIn(install, stub, { url: web.url });
  for (const login of ["pia", "alice"]) {
    const pair = (await signIn.signIn(login)).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
    cookies.set(login, pair.slice("tiehall.session_token=".length));
  }
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
}, 60_000);

interface Watched {
  page: Page;
  /** The policy messages the console showed. */
  console: string[];
}

/** A page in a fresh context, signed in as this person or as nobody, that keeps every policy violation it sees. */
async function watched(app: { url: string }, login?: string): Promise<Watched> {
  const context = await browser.newContext();
  const value = login === undefined ? undefined : cookies.get(login);
  if (value !== undefined) await context.addCookies([{ name: "tiehall.session_token", value, url: app.url }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const seen: Watched = { page, console: [] };
  page.on("console", (message) => {
    if (/content security policy|content-security-policy/i.test(message.text())) seen.console.push(message.text());
  });
  await page.addInitScript({
    content: `window.tiehallViolations = [];
document.addEventListener("securitypolicyviolation", (event) => window.tiehallViolations.push(location.pathname + ": " + event.violatedDirective + " " + event.blockedURI));`,
  });
  return seen;
}

/** Opens a path, lets its scripts run, and gives the violations the page reported. */
async function violationsOn({ page }: Watched, app: { url: string }, path: string): Promise<string[]> {
  const answer = await page.goto(`${app.url}${path}`);
  expect(answer?.status() ?? 0, path).toBeLessThan(500);
  await settled(page);
  return page.evaluate("window.tiehallViolations");
}

/** Every path of the inventory a signed-in person opens, the page for a path no route serves included. */
function paths(): string[] {
  return [...Object.entries(PAGES).flatMap(([route, each]) => (route === "confirm/[...command]/route.ts" ? confirmPaths : each)), NO_SUCH_PAGE];
}

describe("every page's policy", () => {
  it.each([
    ["a signed-in admin", "pia"],
    ["a signed-in member", "alice"],
    ["a browser with no session", undefined],
  ])("is broken on no page %s opens", { timeout: 240_000 }, async (_who, login) => {
    const seen = await watched(web, login);
    const violations: string[] = [];
    for (const path of [...paths(), ...(login === undefined ? Object.values(SIGNED_OUT_PAGES).flat() : [])]) violations.push(...(await violationsOn(seen, web, path)));
    expect(violations).toEqual([]);
    expect(seen.console).toEqual([]);
    await seen.page.context().close();
  });

  it("is broken on no page shown when a page fails while it renders", { timeout: 120_000 }, async () => {
    const seen = await watched(errorPage, "pia");
    const answer = await seen.page.goto(`${errorPage.url}/fails/now`);
    expect(answer?.status()).toBe(500);
    expect(answer?.headers()["content-security-policy"]).toMatch(/^default-src 'none'; script-src 'nonce-[^']+' 'strict-dynamic'; style-src 'self';/);
    await seen.page.waitForLoadState("networkidle");
    await seen.page.getByRole("heading", { level: 1 }).waitFor();
    expect(await seen.page.evaluate("window.tiehallViolations")).toEqual([]);
    expect(seen.console).toEqual([]);
    await seen.page.context().close();
  });
});
