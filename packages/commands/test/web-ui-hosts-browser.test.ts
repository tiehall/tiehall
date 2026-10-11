import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { CLI_CLIENT_ID, startSetup } from "../src/index.ts";
import { CLIENT_REDIRECT_URI, pkcePair } from "./support/agent-access.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { namedRoutes, PAGES, routeFiles, seedInventory, SIGNED_OUT_PAGES } from "./support/page-inventory.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The web UI loads nothing from other hosts (self-host-install: No telemetry
// and a documented list of outbound connections; agent-safety: The web UI
// renders no raw HTML and no remote images; design.md, Self-hosting
// decisions: S13). A browser visits every page of the web UI, in the web app
// as the image runs it (web-app.ts), with a log of every request the pages
// make, and the test fails on any request to a host other than the install's:
// no script, style sheet, font, image, frame or connection from anywhere
// else. Every route of the web app is named in the inventory, as a page with
// the paths that show it or as no page, with why; a route that is neither
// fails the test, so a new page is visited once it is added. The pages are seen as
// people see them: an admin signed in with a real web session, a browser that
// is signed in as nobody, and, on a second install whose setup is not
// complete, the operator on the setup screen. The inventory is
// support/page-inventory.ts, which the table test of each page's policy shares.

let stub: GitHubStub;
let browser: Browser;
let install: TestInstall;
let web: WebApp;
let signIn: SignInHarness;
/** An install whose setup is not complete, with its web app and the setup code its start printed. */
let fresh: { install: TestInstall; web: WebApp; code: string };
/** The paths of the confirm pages, once their proposal and review exist. */
const confirmPaths: string[] = [];

beforeAll(async () => {
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  install = await startTestInstall();
  confirmPaths.push(...(await seedInventory(install, stub)).confirmPaths);
  web = await startWebApp(install);
  signIn = await startSignIn(install, stub, { url: web.url });

  // The second install, whose setup is not complete: its start printed a setup code.
  const unset = await startTestInstall();
  // As at an install's first start: the org exists, unnamed, and setup is not complete.
  await unset.owner.query("UPDATE orgs SET name = NULL, setup_completed_at = NULL");
  const freshWeb = await startWebApp(unset);
  const started = await startSetup({ database: unset.db, url: freshWeb.url, logger: unset.logger });
  fresh = { install: unset, web: freshWeb, code: started?.code ?? "" };
  expect(fresh.code).not.toBe("");

  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: web.browserArgs });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await web?.close();
  await fresh?.web.close();
  await fresh?.install.close();
  await install?.close();
  await stub?.close();
}, 60_000);

/** A browser context that logs every request its pages make, signed in with this cookie or as nobody. */
async function loggedContext(app: WebApp, cookie?: { name: string; value: string }): Promise<{ context: BrowserContext; requested: string[] }> {
  const context = await browser.newContext();
  if (cookie !== undefined) await context.addCookies([{ ...cookie, url: app.url }]);
  const requested: string[] = [];
  context.on("request", (request) => void requested.push(request.url()));
  return { context, requested };
}

/** The session cookie of a person's browser, signed in to the web app with GitHub. */
async function cookieOf(login: string): Promise<{ name: string; value: string }> {
  const [name = "", value = ""] = ((await signIn.signIn(login)).jar.header().split("; ").find((pair) => pair.startsWith("tiehall.session_token=")) ?? "").split(/=(.*)/s);
  return { name, value };
}

/** Opens a path, waits until the page has settled, and fails on an answer that is a server error. */
async function visit(page: Page, app: WebApp, path: string): Promise<void> {
  const answer = await page.goto(`${app.url}${path}`);
  expect(answer?.status() ?? 0, path).toBeLessThan(500);
  await page.waitForLoadState("networkidle");
}

/** The requests made to a host other than the app's, by the URL they asked for. */
function toOtherHosts(app: WebApp, requested: readonly string[]): string[] {
  const host = new URL(app.url).host;
  return requested.filter((url) => !url.startsWith("data:") && new URL(url).host !== host);
}

/** Registers a native agent client with the web app, as an MCP client does, and returns its id. */
async function registerClient(app: WebApp): Promise<string> {
  const answer = await app.fetch("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: [CLIENT_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const body = (await answer.json()) as { client_id?: string };
  expect(answer.status, JSON.stringify(body)).toBe(201);
  return body.client_id ?? "";
}

/** Starts the device flow of the tiehall CLI with the web app, as `tiehall login` does, and returns the code it would print. */
async function startDeviceFlow(app: WebApp): Promise<string> {
  const answer = await app.fetch("/api/auth/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLI_CLIENT_ID, resource: `${app.url}/mcp`, scope: "requests:read requests:write" }).toString(),
  });
  const body = (await answer.json()) as { user_code?: string };
  expect(answer.status, JSON.stringify(body)).toBe(200);
  return body.user_code ?? "";
}

describe("the web UI's pages and the hosts they load from", () => {
  it("names every route of the web app as a page it visits or as no page, with why", () => {
    expect(routeFiles()).toEqual(namedRoutes());
  });

  it("logs a request to another host, so a page that made one would fail the test", { timeout: 60_000 }, async () => {
    const { context, requested } = await loggedContext(web);
    const page = await context.newPage();
    await page.setContent('<img src="http://tracker.example/pixel.png">');
    await page.waitForLoadState("networkidle");
    expect(toOtherHosts(web, requested)).toEqual(["http://tracker.example/pixel.png"]);
    await context.close();
  });

  it("makes no request to another host on any page a signed-in admin opens", { timeout: 240_000 }, async () => {
    const { context, requested } = await loggedContext(web, await cookieOf("pia"));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const visited: string[] = [];
    for (const [route, paths] of Object.entries(PAGES)) {
      for (const path of route === "confirm/[...command]/route.ts" ? confirmPaths : paths) {
        await visit(page, web, path);
        visited.push(path);
      }
    }
    // A path that is no page gets the web app's own page that says so.
    await visit(page, web, "/no-such-page");
    expect(visited).toEqual(expect.arrayContaining(["/FE-1", "/FE", ...confirmPaths]));
    expect(requested.length).toBeGreaterThan(visited.length);
    expect(toOtherHosts(web, requested)).toEqual([]);
    await context.close();
  });

  // The consent screen and the device approval's review are pages only an agent client's authorization request and a
  // code the CLI printed lead to (agent-access: The consent screen shows who is asking; agent-access: The CLI signs in
  // through a restricted device flow); the admin's browser reaches both as a member does.
  it("makes no request to another host on an agent client's consent screen and a device code's review", { timeout: 120_000 }, async () => {
    const clientId = await registerClient(web);
    const userCode = await startDeviceFlow(web);
    const { context, requested } = await loggedContext(web, await cookieOf("pia"));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT_URI,
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
      state: "state-1",
      resource: `${web.url}/mcp`,
      scope: "requests:read requests:write",
    });
    await visit(page, web, `/api/auth/oauth2/authorize?${authorization.toString()}`);
    expect(new URL(page.url()).pathname).toBe("/consent");
    await page.getByRole("heading", { name: "Approve an agent client" }).waitFor();
    await visit(page, web, "/device");
    await page.getByLabel("The code tiehall login printed").fill(userCode);
    await Promise.all([page.waitForURL(`${web.url}/device`), page.getByRole("button", { name: "Continue" }).click()]);
    await page.waitForLoadState("networkidle");
    await page.getByText("The tiehall CLI asks to act for you in Tiehall.").waitFor();
    expect(toOtherHosts(web, requested)).toEqual([]);
    await context.close();
  });

  it("makes no request to another host on the pages a browser signed in as nobody opens", { timeout: 120_000 }, async () => {
    const { context, requested } = await loggedContext(web);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    for (const paths of Object.values(SIGNED_OUT_PAGES)) for (const path of paths) await visit(page, web, path);
    // A page that needs a session sends the browser to the sign-in page.
    await visit(page, web, "/FE-1");
    expect(new URL(page.url()).pathname).toBe("/sign-in");
    expect(toOtherHosts(web, requested)).toEqual([]);
    await context.close();
  });

  it("makes no request to another host on the setup screen, from the setup code to the GitHub App's step", { timeout: 120_000 }, async () => {
    // The browser reaches both installs' web apps through the same rule, localhost to 127.0.0.1.
    const { context, requested } = await loggedContext(fresh.web);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await visit(page, fresh.web, "/setup");
    await page.getByLabel("Setup code").fill(fresh.code);
    await Promise.all([page.waitForURL(`${fresh.web.url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("The company's name").fill("Acme");
    await Promise.all([page.waitForURL(`${fresh.web.url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
    await page.getByRole("button", { name: "Create the GitHub App" }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(toOtherHosts(fresh.web, requested)).toEqual([]);
    await context.close();
  });
});
