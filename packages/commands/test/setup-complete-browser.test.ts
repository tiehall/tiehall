import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { openSetupSession } from "../src/index.ts";
import { startAppServer, type AppServer } from "./support/app-server.ts";

// Completing setup in a real browser (self-host-install: Setup names the
// company and makes the first admin; teams-and-roles: One org per install;
// activity-log: Which actions are security events; tracker-mirrors: Admins
// connect GitHub installations with the confirmation step; github-app-
// reachability: design.md, Design rules: Finding installations). The operator
// enters the setup code, names the company, creates the App on GitHub,
// installs it on the organization and signs in with GitHub from the setup
// session. The sign-in makes them the first admin, connects the installation
// made during setup, which Tiehall finds by listing the App's installations,
// and closes setup for good. GitHub is the stub; it never delivers a webhook to
// the install here: at https://tiehall.example.com the App has a webhook, but
// the delivery for the installation never reaches the install, and on a trial
// URL the App has no webhook at all.

let stub: GitHubStub;
let server: AppServer;
let browser: Browser;

// The hooks start the GitHub stub for each test and close it, the install and Chrome after it, so they get timeouts that
// hold on a CI runner, not Vitest's 10-second default for hooks.
beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
  stub.addRepo("acme/private-notes");
  // The browser that follows the setup screen to GitHub is signed in to GitHub as Omar.
  stub.signIn("omar");
}, 60_000);

afterEach(async () => {
  await browser?.close();
  await server?.close();
  await stub?.close();
}, 60_000);

async function launch(): Promise<Browser> {
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  return chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: server.browserArgs });
}

/** The operator's way through the setup screen and GitHub's pages, up to and including the sign-in; the repositories name the installation's selection. */
async function completeSetup(page: Page, code: string, repositories: readonly string[]): Promise<void> {
  const { url } = server;
  await page.goto(`${url}/setup`);
  await page.getByLabel("Setup code").fill(code);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);

  // The company's name, then the App, owned by the organization acme.
  await page.getByLabel("The company's name").fill("Acme");
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
  await page.getByLabel("The GitHub organization that owns the App").fill("acme");
  await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);

  // Installing the App on acme, with the repositories chosen on GitHub's page.
  const [app] = stub.apps();
  await Promise.all([page.waitForURL(`${stub.webUrl}/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
  await page.getByLabel("Only select repositories").check();
  for (const repository of repositories) await page.getByLabel(repository).check();
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/installations/*`), page.getByRole("button", { name: "Install" }).click()]);

  // Back on the setup screen, the sign-in from the setup session completes setup.
  await page.goto(`${url}/setup`);
  await Promise.all([page.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
  await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
}

async function firstAdmin(): Promise<{ login: string; role: string }[]> {
  const { rows } = await server.owner.query<{ login: string; role: string }>(
    "SELECT u.github_login AS login, m.role FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id",
  );
  return rows;
}

async function connectedInstallations(): Promise<string[]> {
  const { rows } = await server.owner.query<{ installation_id: string }>(
    "SELECT i.installation_id FROM github_connected_installations c JOIN github_installations i ON i.org_id = c.org_id AND i.id = c.installation_id",
  );
  return rows.map(({ installation_id }) => installation_id);
}

async function coveredRepositories(): Promise<string[]> {
  const { rows } = await server.owner.query<{ full_name: string }>("SELECT full_name FROM github_covered_repositories ORDER BY full_name");
  return rows.map(({ full_name }) => full_name);
}

describe("completing setup", { timeout: 120_000 }, () => {
  it("names the company, makes the operator the first admin, connects the installation made during setup and closes setup for good", async () => {
    server = await startAppServer(stub);
    browser = await launch();
    const code = await server.start();
    const context = await browser.newContext();
    const page = await context.newPage();

    await completeSetup(page, code, ["acme/web", "acme/api"]);

    // Signed in, on the web UI.
    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);
    const { rows: orgs } = await server.owner.query<{ name: string; completed: boolean }>("SELECT name, setup_completed_at IS NOT NULL AS completed FROM orgs");
    expect(orgs).toEqual([{ name: "Acme", completed: true }]);
    expect(await firstAdmin()).toEqual([{ login: "omar", role: "admin" }]);

    // The installation made during setup is connected, although its delivery never reached the install.
    const [installation] = stub.installations();
    expect(await connectedInstallations()).toEqual([String(installation?.id)]);
    expect(await coveredRepositories()).toEqual(["acme/api", "acme/web"]);
    const [app] = stub.apps();
    expect(app?.hook?.url).toBe("https://tiehall.example.com/webhooks/github");
    expect(stub.deliveries(app!).map(({ event, statusCode }) => ({ event, delivered: statusCode >= 200 && statusCode < 300 }))).toEqual([
      { event: "ping", delivered: false },
      { event: "installation", delivered: false },
    ]);
    expect((await server.owner.query("SELECT delivery_id FROM github_deliveries")).rows).toEqual([]);

    // The activity log names the first admin.
    const { rows: events } = await server.owner.query<{ type: string; user_id: string; login: string }>(
      `SELECT e.type, e.data->>'userId' AS user_id, u.github_login AS login
         FROM events e JOIN users u ON u.org_id = e.org_id AND u.id = (e.data->>'userId')::uuid
        WHERE e.type = 'setup.completed'`,
    );
    expect(events.map(({ type, login }) => ({ type, login }))).toEqual([{ type: "setup.completed", login: "omar" }]);

    // Setup is closed: the code opens nothing, /setup answers 404, and pages and /api/v1 are served.
    expect(await openSetupSession(server.db, code)).toBeUndefined();
    const setupAgain = await page.goto(`${server.url}/setup`);
    expect(setupAgain?.status()).toBe(404);
    const home = await page.goto(`${server.url}/`);
    expect(home?.status()).toBe(200);
    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);
    const openapi = await page.goto(`${server.url}/api/v1/openapi.json`);
    expect(openapi?.status()).toBe(200);
    expect(((await openapi?.json()) as { openapi?: string }).openapi).toBe("3.1.0");
    await context.close();
  });

  it("completes on a trial URL with no delivery at all: the installation is found by listing and its two repositories are covered", async () => {
    server = await startAppServer(stub, { trial: true });
    browser = await launch();
    const code = await server.start();
    const context = await browser.newContext();
    const page = await context.newPage();

    await completeSetup(page, code, ["acme/web", "acme/api"]);

    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);
    expect(await firstAdmin()).toEqual([{ login: "omar", role: "admin" }]);
    const [app] = stub.apps();
    expect(app?.hook).toBeNull();
    const [installation] = stub.installations();
    expect(await connectedInstallations()).toEqual([String(installation?.id)]);
    expect(await coveredRepositories()).toEqual(["acme/api", "acme/web"]);
    expect(stub.received.some((call) => call.host === "api" && call.method === "GET" && call.path === "/app/installations")).toBe(true);
    expect(stub.deliveries(app!)).toEqual([]);

    // GitHub runs in polling mode, whose first poll the completion sent (github-app-reachability 1.7).
    expect(server.sentJobs).toContainEqual({ queue: "github.poll.v1", data: {} });
    await page.goto(`${server.url}/admin/github`);
    await expect(page.getByText("GitHub runs in polling mode").count()).resolves.toBe(1);
    await context.close();
  });
});
