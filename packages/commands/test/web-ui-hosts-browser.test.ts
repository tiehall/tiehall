import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { CLI_CLIENT_ID, startSetup } from "../src/index.ts";
import { CLIENT_REDIRECT_URI, pkcePair } from "./support/agent-access.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { addTeam, callApi, joinTeams, openRequest, sessionOf, tokenOf } from "./support/requests.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";
import { startWebApp, type WebApp } from "./support/web-app.ts";

// The web UI loads nothing from other hosts (self-host-install: No telemetry
// and a documented list of outbound connections; agent-safety: The web UI
// renders no raw HTML and no remote images; design.md, Self-hosting
// decisions: S13). A browser visits every page of the web UI, in the web app
// as the image runs it (web-app.ts), with a log of every request the pages
// make, and the test fails on any request to a host other than the install's:
// no script, style sheet, font, image, frame or connection from anywhere
// else. Every route of the web app is named below, as a page with the paths
// that show it or as no page, with why; a route that is neither fails the
// test, so a new page is visited once it is added. The pages are seen as
// people see them: an admin signed in with a real web session, a browser that
// is signed in as nobody, and, on a second install whose setup is not
// complete, the operator on the setup screen.

/** The web app's routes, apps/web/app. */
const APP = fileURLToPath(new URL("../../../apps/web/app/", import.meta.url));

/** The pages of the web UI, by their route file under apps/web/app, and the paths a signed-in admin opens to see them. */
const PAGES: Readonly<Record<string, readonly string[]>> = {
  "route.ts": ["/"],
  "inbox/route.ts": ["/inbox"],
  "settings/email/route.ts": ["/settings/email"],
  "members/route.ts": ["/members"],
  "requests/route.ts": ["/requests", "/requests?list=opened", "/requests?list=all"],
  "requests/new/route.ts": ["/requests/new", "/requests/new?team=FE"],
  "[key]/page.tsx": ["/FE-1", "/FE", "/QA"],
  "tokens/route.ts": ["/tokens"],
  "admin/route.ts": ["/admin"],
  "admin/invites/route.ts": ["/admin/invites"],
  "admin/teams/route.ts": ["/admin/teams"],
  "admin/sign-in-policy/route.ts": ["/admin/sign-in-policy"],
  "admin/personal-access-tokens/route.ts": ["/admin/personal-access-tokens"],
  "admin/github/route.ts": ["/admin/github"],
  "admin/apis/route.ts": ["/admin/apis"],
  "admin/activity-log/route.ts": ["/admin/activity-log"],
  // A proposal's confirm page and an admin action's review page; the paths are filled in once they exist.
  "confirm/[...command]/route.ts": [],
  // Reached from an agent client's authorization request, which the admin's browser starts once the client has
  // registered; without one, it answers with a page that says so.
  "consent/route.ts": ["/consent"],
  // Where a member types the code `tiehall login` printed; the test also types a code and opens its review.
  "device/route.ts": ["/device"],
  "docs/api/route.ts": ["/docs/api"],
  "docs/api/changelog/route.ts": ["/docs/api/changelog"],
};

/** The pages a browser signed in as nobody opens. */
const SIGNED_OUT_PAGES: Readonly<Record<string, readonly string[]>> = {
  "sign-in/route.ts": ["/sign-in"],
};

/** The setup screen, which only an install whose setup is not complete serves; its steps are visited in order. */
const SETUP = "setup/[[...step]]/route.ts";

/** The routes that are no page of the web UI, and why. */
const NOT_PAGES: Readonly<Record<string, string>> = {
  ".well-known/[...path]/route.ts": "discovery documents for agent clients",
  "api/auth/[...all]/route.ts": "the sign-in service's routes, which GitHub's pages lead back to",
  "api/v1/[...path]/route.ts": "the REST API",
  "mcp/route.ts": "the MCP endpoint",
  "webhooks/github/route.ts": "GitHub's webhook deliveries",
  "schemas/packet/v1-beta.json/route.ts": "the packet schema, a JSON document",
  "healthz/route.ts": "the health check",
  "sign-out/route.ts": "the sign-out form's target, which only answers its post",
  "teams/apis/route.ts": "the target of the forms of a team's page, which only answers their posts",
  "mirrors/retry/route.ts": "the target of a failed mirror job's Retry button, which only answers its post",
  "docs/api/reference.js/route.ts": "a script of the API reference page, which that page loads",
  "docs/api/scalar.js/route.ts": "a script of the API reference page, which that page loads",
  "assets/[...path]/route.ts": "the install's own assets, such as its stylesheet, fonts and icons, which the pages load",
};

/** Every route file of the web app: its route handlers and its pages. */
function routeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts" || entry.name === "page.tsx") found.push(relative(APP, path).split(sep).join("/"));
    }
  };
  walk(APP);
  return found.sort();
}

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
  const be = await addTeam(install.owner, "BE");
  const fe = await addTeam(install.owner, "FE");
  await addTeam(install.owner, "QA");
  await install.owner.query("UPDATE teams SET intake_notes = 'One request per screen.', required_fields = ARRAY['acceptance_criteria'] WHERE key = 'FE'");
  const pia = await addUser(install.owner, { login: "pia", role: "admin", githubAccountId: stub.addUser({ login: "pia" }).id });
  const alice = await addUser(install.owner, { login: "alice", githubAccountId: stub.addUser({ login: "alice" }).id });
  await joinTeams(install.owner, pia, fe);
  await joinTeams(install.owner, alice, be);
  await openRequest(install, tokenOf(alice), {
    targetTeam: "FE",
    title: "Add a dark mode",
    packet: {
      schema_version: "1-beta",
      kind: "request",
      untrusted: { need: "![x](https://tracker.example/pixel.png)", acceptance_criteria: ["It follows the system setting."], links: [{ url: "https://design.example.com/dark" }] },
    },
  });
  expect((await callApi(install, tokenOf(alice), "POST", "/api/v1/requests/FE-1/messages", { kind: "comment", body: "<img src=https://tracker.example/pixel.png>" })).status).toBe(200);
  const declined = await callApi(install, tokenOf(pia), "POST", "/api/v1/requests/FE-1/status", { state: "declined" });
  expect(declined.status).toBe(202);
  confirmPaths.push(`/confirm/${declined.body.proposal.id}`);
  confirmPaths.push(`/confirm/members.change_role?input=${encodeURIComponent(JSON.stringify({ userId: alice, role: "admin" }))}`);
  // A personal access token, which the tokens page lists.
  expect((await install.confirm(sessionOf(pia), "personal_access_tokens.create", { name: "Agent", scopes: ["requests:read"], expiresInDays: 30 })).status).toBe(200);
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
    const named = [...Object.keys(PAGES), ...Object.keys(SIGNED_OUT_PAGES), SETUP, ...Object.keys(NOT_PAGES)].sort();
    expect(routeFiles()).toEqual(named);
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
