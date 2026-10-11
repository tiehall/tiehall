import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneWidthProblems } from "./support/layout.ts";
import { seedRequestPages } from "./support/request-pages.ts";
import { openRequestInTheWebUi, sessionOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The inbox and the member's pages at phone width (web-ui: Pages work at
// phone width; web-ui: Pages are accessible; design.md, Design: Phone width;
// D57 (7), (8)): at 320 CSS pixels the home page, the inbox, the members,
// email settings and connected agents and tokens scroll no page sideways, and
// every control they show is at least 24 by 24 CSS pixels, apart from links
// inside a sentence or a block of text. Pia, an admin in FE, has a proposal
// waiting for their confirmation, a receipt they can still undo, and a
// personal access token.

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let session = "";

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const seed = await seedRequestPages(install, stub);
  // FE-3, which Pia declines and confirms the decline of, which leaves them a receipt with its undo link for 15 minutes.
  await openRequestInTheWebUi(install, seed.alice, {
    targetTeam: "FE",
    title: "Fix the footer",
    packet: { schema_version: "1-beta", kind: "request", untrusted: { need: "The footer overlaps the content.", acceptance_criteria: ["It never overlaps"] } },
  });
  const pia = sessionOf(seed.pia);
  const declined = await install.web(pia).write("requests.set_status", { key: "FE-3", state: "declined" }, install.fromThePage(pia));
  expect(declined).toMatchObject({ ok: true });
  const proposal = declined.ok ? (declined.output as { proposal: { id: string } }).proposal.id : "";
  expect((await install.confirm(pia, "proposals.confirm", { proposal })).status).toBe(200);
  expect((await install.confirm(pia, "personal_access_tokens.create", { name: "Deploy", scopes: ["requests:read"], expiresInDays: 30 })).status).toBe(200);
  web = await startWebApp(install);
  const pair = (await (await startSignIn(install, stub, { url: web.url })).signIn("pia")).jar.header().split("; ").find((each) => each.startsWith("tiehall.session_token=")) ?? "";
  session = pair.slice("tiehall.session_token=".length);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await stub?.close();
  await install?.close();
}, 300_000);

describe("the inbox and the member's pages at 320 CSS pixels", () => {
  it.each(["/", "/inbox", "/members", "/settings/email", "/tokens"])("%s scrolls no page sideways, and every control is at least 24 by 24 CSS pixels", { timeout: 120_000 }, async (path) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme });
      await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}${path}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      expect(await phoneWidthProblems(page), `${path} ${colorScheme}`).toEqual([]);
      await context.close();
    }
  });

  it("shows the inbox's waiting proposal, its receipt with the undo link, and the updates", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/inbox`);
    await expect(page.locator("#waiting li").count()).resolves.toBe(1);
    await expect(page.locator("#waiting li").getByRole("link", { name: "Review and confirm" }).isVisible()).resolves.toBe(true);
    await expect(page.locator("#receipts li").getByRole("link", { name: /^Undo · \d+ min left$/ }).isVisible()).resolves.toBe(true);
    await expect(page.getByRole("button", { name: "Acknowledge these updates" }).isVisible()).resolves.toBe(true);
    await context.close();
  });
});
