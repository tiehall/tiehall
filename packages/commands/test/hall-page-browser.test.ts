import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { phoneWidthProblems, runningAnimations } from "./support/layout.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, oauthTokenOf, openRequest, tokenOf } from "./support/requests.ts";
import { startSignIn } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The live hall's page in a browser, before its script runs (web-ui: The live
// hall; web-ui: Light and dark themes follow the system; web-ui: Motion, and
// reduced motion; web-ui: Pages work at phone width; design.md, Design: The
// live hall; design.md, Design: Motion and reduced motion; D57 (5), (6), (7),
// (11)). With scripts off, /hall shows the people and agents at work, the
// feed, the teams and the lines between them as they stood when it was
// served, says that it updates only with scripts on, shows no Pause motion
// button, and runs no animation 5.5 seconds after it loads; its background is
// the dark ground whether the browser prefers dark or light; and at 320 CSS
// pixels it scrolls no page sideways. The web app runs as the image runs it,
// and Pia signs in with GitHub through the stub.

const EXAMPLE_AGENT = "https://client.example.com/tiehall.json";

let install: TestInstall;
let stub: GitHubStub;
let web: WebApp;
let browser: Browser;
let session = "";

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  const team: Record<string, string> = {};
  for (const [key, name] of [
    ["BE", "Backend"],
    ["FE", "Frontend"],
    ["PAY", "Payments"],
  ] as const) {
    team[key] = await addTeam(install.owner, key);
    await install.owner.query("UPDATE teams SET name = $2 WHERE id = $1", [team[key], name]);
  }
  const pia = await addUser(install.owner, { login: "pia", role: "admin", githubAccountId: stub.addUser({ login: "pia" }).id });
  const mert = await addUser(install.owner, { login: "mert" });
  const ayse = await addUser(install.owner, { login: "ayse" });
  await joinTeams(install.owner, pia, team["FE"] ?? "");
  await joinTeams(install.owner, mert, team["FE"] ?? "");
  await joinTeams(install.owner, ayse, team["PAY"] ?? "");
  await install.owner.query(
    "INSERT INTO oauth_clients (org_id, client_id, name, client_discovery_id, redirect_uris) SELECT id, $1, 'Example Agent', 'cimd', ARRAY['https://client.example.com/callback'] FROM orgs",
    [EXAMPLE_AGENT],
  );
  // FE-1, from PAY, on which Mert's agent works; PAY-1, from FE, on which Ayşe's agent asked a blocking question.
  await openRequest(install, tokenOf(ayse), { targetTeam: "FE", title: "Show the refund status" });
  const mertsAgent = oauthTokenOf(mert, EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/claim")).status).toBe(200);
  expect((await callApi(install, mertsAgent, "POST", "/api/v1/requests/FE-1/status", { state: "in_progress" })).status).toBe(200);
  await openRequest(install, tokenOf(mert), { targetTeam: "PAY", title: "Send a refund webhook" });
  const aysesAgent = oauthTokenOf(ayse, EXAMPLE_AGENT, "mcp");
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/claim")).status).toBe(200);
  expect((await callApi(install, aysesAgent, "POST", "/api/v1/requests/PAY-1/messages", { kind: "question", body: "Which currency?", blocking: true })).status).toBe(200);
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

/** Pia's browser, signed in, with this viewport, color scheme and scripts on or off. */
async function signedIn(options: { width?: number; height?: number; colorScheme?: "light" | "dark"; javaScriptEnabled?: boolean } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    colorScheme: options.colorScheme ?? "light",
    javaScriptEnabled: options.javaScriptEnabled ?? true,
  });
  await context.addCookies([{ name: "tiehall.session_token", value: session, url: web.url }]);
  return context;
}

describe("the live hall without scripts", () => {
  it("shows the people and agents at work, the feed, the teams and the lines, says it updates only with scripts on, and shows no Pause motion", { timeout: 120_000 }, async () => {
    const context = await signedIn({ javaScriptEnabled: false });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/hall`);
    await page.getByRole("heading", { level: 1, name: "Live hall" }).waitFor();
    for (const name of ["At work", "On the line", "Teams", "Lines between teams"]) await expect(page.getByRole("heading", { name, exact: true }).isVisible(), name).resolves.toBe(true);
    await expect(page.getByText("Not live: updates need JavaScript").isVisible()).resolves.toBe(true);
    await expect(page.locator("#at-work").getByText("ayse's agent · Example Agent (client.example.com)").isVisible()).resolves.toBe(true);
    await expect(page.locator("#feed").getByText("A blocking question was posted").isVisible()).resolves.toBe(true);
    await expect(page.locator("#team-list").getByText("1 needs info").isVisible()).resolves.toBe(true);
    await expect(page.locator("#hall-lines").getByText("1 in progress").isVisible()).resolves.toBe(true);
    await expect(page.getByRole("button", { name: "Pause motion" }).isVisible()).resolves.toBe(false);
    await expect(page.locator("#hall-map").isVisible()).resolves.toBe(false);
    await context.close();
  });

  it("runs no animation 5.5 seconds after it loads", { timeout: 120_000 }, async () => {
    const context = await signedIn({ javaScriptEnabled: false });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/hall`);
    await page.getByRole("heading", { level: 1, name: "Live hall" }).waitFor();
    expect((await runningAnimations(page)).length).toBeGreaterThan(0);
    // The time bound itself is what this test measures.
    await page.waitForTimeout(5_500);
    expect(await runningAnimations(page)).toEqual([]);
    await context.close();
  });
});

describe("the live hall's theme", () => {
  it.each(["dark", "light"] as const)("is dark in a browser that prefers %s: its background is #0E1117", { timeout: 120_000 }, async (colorScheme) => {
    const context = await signedIn({ colorScheme });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/hall`);
    await page.getByRole("heading", { level: 1, name: "Live hall" }).waitFor();
    await expect(page.locator("body").evaluate((body) => body.ownerDocument.defaultView?.getComputedStyle(body).backgroundColor)).resolves.toBe("rgb(14, 17, 23)");
    await expect(page.locator("body").evaluate((body) => body.ownerDocument.defaultView?.getComputedStyle(body).color)).resolves.toBe("rgb(232, 234, 240)");
    await context.close();
  });
});

describe("the live hall at 320 CSS pixels", () => {
  it("scrolls no page sideways, and every control is at least 24 by 24 CSS pixels", { timeout: 120_000 }, async () => {
    const context = await signedIn({ width: 320, height: 640 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${web.url}/hall`);
    await page.getByRole("heading", { level: 1, name: "Live hall" }).waitFor();
    expect(await phoneWidthProblems(page)).toEqual([]);
    await context.close();
  });
});
