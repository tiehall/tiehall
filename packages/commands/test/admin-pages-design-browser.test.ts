import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { addInstallation } from "./support/apis.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneHeightProblems, phoneWidthProblems, wrappedCells } from "./support/layout.ts";
import { seedInventory } from "./support/page-inventory.ts";
import { sessionOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The admin pages at phone width (web-ui: Pages work at phone width; web-ui:
// Pages are accessible; design.md, Design: Phone width; D57 (7), (8)): at 320
// CSS pixels, in the light and the dark scheme, the admin overview and each
// area's page scroll no page sideways, except inside a table's own box, and
// every control they show is at least 24 by 24 CSS pixels, apart from links
// inside a sentence or a block of text. Pia, an admin, opens them; the install
// has a connected installation and a registered API, so the GitHub page and
// the APIs page show their lists and tables.

const ADMIN_PAGES = ["/admin", "/admin/invites", "/admin/teams", "/admin/sign-in-policy", "/admin/personal-access-tokens", "/admin/github", "/admin/apis", "/admin/activity-log"];

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let session = "";

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const seed = await seedInventory(install, stub);
  await addInstallation(install.owner, { account: "acme", repositories: [{ fullName: "acme/payments", id: 7001 }] });
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = 'BE'");
  expect((await install.confirm(sessionOf(seed.pia), "apis.register", { name: "payments-api", team: rows[0]?.id, repository: "acme/payments" })).status).toBe(200);
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

describe("the admin overview's cards", () => {
  it.each([
    ["light", "rgb(110, 75, 7)"],
    ["dark", "rgb(240, 203, 106)"],
  ] as const)("draw a notice inside a card in the notice colors, not the card's secondary text, in the %s scheme", { timeout: 120_000 }, async (colorScheme, noticeInk) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme });
    await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/admin`);
    // No backup has finished on a test install, so the Backups card warns.
    const notice = page.locator(".card .notice", { hasText: "No backup has finished yet." });
    await expect(notice.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).color)).resolves.toBe(noticeInk);
    await context.close();
  });
});

describe("the admin overview's list of documentation", () => {
  it("puts each bullet on the first line of its link, however many lines the link takes", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/admin`);
    // A list item's bullet sits on the baseline of its first line, where a character put before the link sits too.
    const placed = await page.locator(".link-list > li").evaluateAll((items) =>
      items.map((item) => {
        const link = item.querySelector("a");
        const probe = item.ownerDocument.createElement("span");
        probe.textContent = "\u200b";
        item.prepend(probe);
        const lines = Math.round((link?.getBoundingClientRect().height ?? 0) / 20);
        const offset = Math.round(probe.getBoundingClientRect().top - (link?.getBoundingClientRect().top ?? 0));
        probe.remove();
        return { lines, offset };
      }),
    );
    expect(placed.some(({ lines }) => lines > 1)).toBe(true);
    for (const { offset } of placed) expect(Math.abs(offset)).toBeLessThan(8);
    await context.close();
  });
});

describe("the activity log's table at 1,280 CSS pixels", () => {
  it("keeps each event's number, time, class, type and request on one line, so no column shrinks until its words break", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/admin/activity-log`);
    await expect(page.locator("table.log tbody tr").count()).resolves.toBeGreaterThan(3);
    expect(await wrappedCells(page, "table.log tbody td:nth-child(-n+5)")).toEqual([]);
    await context.close();
  });
});

describe("the admin pages at 320 CSS pixels", () => {
  it.each(ADMIN_PAGES)("%s scrolls no page sideways but inside a table's box, every control is at least 24 by 24 CSS pixels, and every button, field and navigation item at least 44 high", { timeout: 120_000 }, async (path) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme });
      await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(`${web.url}${path}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      expect(await phoneWidthProblems(page, { tablesScroll: true }), `${path} ${colorScheme}`).toEqual([]);
      expect(await phoneHeightProblems(page), `${path} ${colorScheme}`).toEqual([]);
      await context.close();
    }
  });
});
