import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startSetup } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneHeightProblems, phoneWidthProblems } from "./support/layout.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The setup screen before setup completes, in a browser (self-host-install:
// The setup code guards the setup screen; web-ui: The install serves its own
// assets; web-ui: Text in the system's fonts; web-ui: Pages work at phone
// width; design.md, Design: The install's assets; design.md, Design: The page
// families; D57 (7), (14); D61 (1)): on a test install whose setup is not
// complete, a browser with no setup session opens /setup and gets the
// install's stylesheet and the icons, each answered 200, and no font, so the
// screen has its look in the system's own fonts; it fits a phone's width; and
// the operator enters the setup code and reaches the next step.

let stub: GitHubStub;
let install: TestInstall;
let web: WebApp;
let browser: Browser;
let code = "";

beforeAll(async () => {
  stub = await startGitHubStub();
  install = await startTestInstall();
  await install.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
  web = await startWebApp(install);
  const started = await startSetup({ database: install.db, url: web.url, logger: install.logger });
  code = started?.code ?? "";
  expect(code).not.toBe("");
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await install?.close();
  await stub?.close();
}, 300_000);

describe("the setup screen before setup", () => {
  it("loads the stylesheet and the icons with no setup session, and no font, and takes the setup code", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const answered = new Map<string, number>();
    const fonts: string[] = [];
    page.on("response", (response) => answered.set(new URL(response.url()).pathname, response.status()));
    page.on("request", (request) => {
      if (request.resourceType() === "font") fonts.push(request.url());
    });
    await page.goto(`${web.url}/setup`);
    await page.getByLabel("Setup code").waitFor();
    // The page's text is in the system's own fonts: it declares no font face and asks for no font.
    await page.evaluate("document.fonts.ready");
    await expect(page.evaluate("document.fonts.size")).resolves.toBe(0);
    expect(fonts).toEqual([]);
    expect(answered.get("/assets/tiehall.css")).toBe(200);
    // The icons load once the browser asks for them.
    for (const icon of ["/assets/icon.svg", "/favicon.ico", "/assets/icon-180.png", "/assets/manifest.webmanifest"]) {
      const response = await context.request.get(`${web.url}${icon}`);
      expect(response.status(), icon).toBe(200);
    }
    await expect(page.locator("ol.steps li[aria-current=step]").textContent()).resolves.toContain("Setup code");
    await page.getByLabel("Setup code").fill(code);
    await Promise.all([page.waitForURL(`${web.url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await expect(page.locator("ol.steps li[aria-current=step]").textContent()).resolves.toContain("Company name");
    await expect(page.getByLabel("The company's name").isVisible()).resolves.toBe(true);
    await context.close();
  });

  it("fits a phone's width at 320 CSS pixels, its controls at least 44 CSS pixels high, with the switchboard above the steps", { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/setup`);
    await page.getByLabel("Setup code").waitFor();
    expect(await phoneWidthProblems(page)).toEqual([]);
    expect(await phoneHeightProblems(page)).toEqual([]);
    const art = await page.locator(".setup-art").boundingBox();
    const flow = await page.locator(".setup-flow").boundingBox();
    expect((art?.y ?? 0) + (art?.height ?? 0)).toBeLessThanOrEqual(flow?.y ?? 0);
    await context.close();
  });
});
