import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { stubGitHubFor, type StubbedGitHub } from "../../src/github.ts";
import { Install } from "../../src/install.ts";

// The fresh-install test (self-host-install: Compose runs Tiehall and
// Postgres; self-host-install: Setup names the company and makes the first
// admin; self-host-install: `init` prints a complete `.env`; design.md,
// Technical decisions: T17). The release's compose.yaml runs with the .env
// that `init` prints, unedited but for the port the test publishes the app on;
// `docker compose up -d` starts it; the setup code comes from `docker compose
// logs app`; and the operator, in a real browser, goes through the setup
// screen and GitHub's manifest flow, installs the App and signs in, becoming
// the first admin, then creates a team and opens a request. GitHub is the stub
// (github.ts). CI runs it on every pull request.

const image = inject("image");

let install: Install;
let github: StubbedGitHub;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  install = await Install.create({ image, name: "tiehall-fresh" });
  github = await stubGitHubFor(install);
  github.stub.addUser({ login: "omar" });
  github.stub.addOrg({ login: "acme", members: { omar: "admin" } });
  github.stub.addRepo("acme/web");
  github.stub.addRepo("acme/api");
  // The operator's browser is signed in to GitHub as Omar.
  github.stub.signIn("omar");
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: github.browserArgs });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  install?.destroy();
  await github?.close();
});

/** The admin's SQL view of the install, as the database owner. */
const sql = (query: string) => install.sql(query);

describe("a fresh install", () => {
  it("starts from the .env init prints, and serves the setup screen", async () => {
    // What init printed runs the image under test at the install's URL.
    expect(install.readEnv("TIEHALL_IMAGE")).toBe(image);
    expect(install.readEnv("TIEHALL_URL")).toBe(install.url);
    const up = install.shell("docker compose up -d", { timeoutSeconds: 600 });
    expect(up.status, up.stderr).toBe(0);
    await install.healthy();
    const answer = await install.fetch("/", { redirect: "manual" });
    expect(answer.status).toBe(307);
    expect(answer.headers.get("location")).toBe(`${install.url}/setup`);
  });

  it("completes setup through the setup screen and the App's manifest flow: the operator is the first admin", async () => {
    const url = install.url;
    // The setup code, as the operator reads it.
    const logs = install.shell("docker compose logs app");
    const code = /enter the setup code ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})/.exec(logs.stdout)?.[1];
    expect(code, logs.stdout).toBeDefined();

    await page.goto(`${url}/setup`);
    await page.getByLabel("Setup code").fill(code!);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    await page.getByLabel("The company's name").fill("Acme");
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
    // A trial URL: the App has no webhook, and GitHub runs in polling mode.
    await expect(page.getByText("GitHub runs in polling mode").count()).resolves.toBe(1);
    await page.getByLabel("The GitHub organization that owns the App").fill("acme");
    await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
    await Promise.all([page.waitForURL("https://github.com/organizations/acme/settings/apps/new?*"), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
    await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);

    // The install converted the code with GitHub and stored the App.
    const [app] = github.stub.apps();
    expect(app?.hook).toBeNull();
    expect(sql("SELECT app_id::text || ' ' || mode FROM github_app")).toBe(`${app?.id} polling`);

    // Installing the App on acme, on GitHub's own page.
    await Promise.all([page.waitForURL(`https://github.com/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
    await page.getByLabel("Only select repositories").check();
    for (const repository of ["acme/web", "acme/api"]) await page.getByLabel(repository).check();
    await Promise.all([page.waitForURL(/\/settings\/installations\//), page.getByRole("button", { name: "Install" }).click()]);

    // The sign-in from the setup session completes setup.
    await page.goto(`${url}/setup`);
    await Promise.all([page.waitForURL("https://github.com/login/oauth/authorize?*"), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
    await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
    await expect(page.getByText("You are signed in.").count()).resolves.toBe(1);

    expect(sql("SELECT name || ' ' || (setup_completed_at IS NOT NULL) FROM orgs")).toBe("Acme true");
    expect(sql("SELECT u.github_login || ' ' || m.role FROM members m JOIN users u ON u.id = m.user_id")).toBe("omar admin");
    expect(sql("SELECT string_agg(full_name, ',' ORDER BY full_name) FROM github_covered_repositories")).toBe("acme/api,acme/web");
    expect((await page.goto(`${url}/setup`))?.status()).toBe(404);
  });

  it("lets the first admin create teams and open a request", async () => {
    const url = install.url;
    await page.goto(`${url}/admin/teams`);
    for (const [key, name] of [
      ["BE", "Backend"],
      ["FE", "Frontend"],
    ] as const) {
      await page.getByLabel("Key", { exact: true }).fill(key);
      await page.getByLabel("Name", { exact: true }).fill(name);
      await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Create the team" }).click()]);
    }
    await page.getByLabel("Add a member to BE").selectOption({ label: "omar" });
    await Promise.all([page.waitForURL(`${url}/admin/teams`), page.getByRole("button", { name: "Add to BE" }).click()]);

    await page.goto(`${url}/requests/new`);
    await page.getByLabel("To team").selectOption("FE");
    await page.getByLabel("From team").selectOption("BE");
    await page.getByLabel("Title").fill("Show the invoice total on the order page");
    await page.getByLabel("What you need").fill("The order page shows each line's price but not the invoice total.");
    await Promise.all([page.waitForURL(`${url}/FE-1`), page.getByRole("button", { name: "Open the request" }).click()]);
    await expect(page.getByText("Show the invoice total on the order page").count()).resolves.toBeGreaterThan(0);

    expect(sql("SELECT t.key || '-' || r.number || ' ' || r.state FROM requests r JOIN teams t ON t.id = r.target_team_id")).toBe("FE-1 open");
    // GitHub was reached only as the stub, through the install's own calls.
    expect(github.stub.received.some(({ host, method, path }) => host === "api" && method === "GET" && path === "/app/installations")).toBe(true);
  });
});
