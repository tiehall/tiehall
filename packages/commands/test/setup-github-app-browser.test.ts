import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import { createTestCertificate } from "@tiehall/testing/tls";
import { createLogger, createSetupRoute, migrate, openDatabase, openSecretBox, startSetup, type Database, type SetupRoute } from "../src/index.ts";

// The way back after GitHub refuses the webhook URL, in a real browser
// (self-host-install: The GitHub App is created with GitHub's manifest flow;
// github-app-reachability: design.md, Design rules: The webhook and the install
// URL). The install is https://tiehall.example.com: a URL that is not a trial
// URL keeps its setup session in a `__Host-` cookie, which a browser keeps only
// over HTTPS. So a local server serves the setup screen over HTTPS with a test
// certificate that the browser trusts by its key, and a host-resolver rule
// sends tiehall.example.com to that server. The GitHub stub refuses the
// install's webhook URL as unreachable, as GitHub may for an install it cannot
// reach: the operator lands on GitHub's error page, comes back to /setup in the
// same browser, gets the App step without the setup code, chooses the option
// that GitHub cannot reach this address, and the App is created without a
// webhook.

const INSTALL = "https://tiehall.example.com";
const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const logger = createLogger({ write: () => {} });

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let stub: GitHubStub;
let server: Server;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });

  stub = await startGitHubStub({ unreachableHookUrls: [`${INSTALL}/webhooks/github`] });
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.signIn("omar");

  const box = openSecretBox(randomBytes(32).toString("base64url"));
  const route = createSetupRoute({ database: db, url: INSTALL, logger, secrets: () => box, github: { webUrl: stub.webUrl, apiUrl: stub.apiUrl } });
  const certificate = createTestCertificate({ dnsNames: ["tiehall.example.com"] });
  server = createServer({ key: certificate.key, cert: certificate.cert }, (incoming, outgoing) => {
    answer(route, incoming, outgoing).catch((error: unknown) => {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({
    ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }),
    args: [`--host-resolver-rules=MAP tiehall.example.com 127.0.0.1:${port}`, `--ignore-certificate-errors-spki-list=${certificate.spkiSha256}`],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await stub?.close();
  await db?.$client.end();
  await owner?.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner?.end();
  await database?.drop();
});

/** Answers the browser with the setup screen, as the install at https://tiehall.example.com. */
async function answer(route: SetupRoute, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = incoming.method ?? "GET";
  const request = new Request(new URL(incoming.url ?? "/", INSTALL), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
  const answered = await route(request);
  const out: Record<string, string | string[]> = Object.fromEntries(answered.headers);
  const cookies = answered.headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  outgoing.writeHead(answered.status, out);
  outgoing.end(Buffer.from(await answered.arrayBuffer()));
}

describe("the way back after GitHub refuses the webhook URL", { timeout: 90_000 }, () => {
  it("brings the operator back to the App step in the same browser, where the option creates the App without a webhook", async () => {
    const started = await startSetup({ database: db, url: INSTALL, logger });
    const context = await browser.newContext();
    const page = await context.newPage();

    // The setup code opens a setup session, whose cookie only HTTPS keeps.
    await page.goto(`${INSTALL}/setup`);
    await page.getByLabel("Setup code").fill(started?.code ?? "");
    await Promise.all([page.waitForURL(`${INSTALL}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
    expect((await context.cookies(INSTALL)).map(({ name }) => name)).toEqual(["__Host-tiehall-setup"]);
    await page.getByLabel("The company's name").fill("Acme");
    await Promise.all([page.waitForURL(`${INSTALL}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);

    // The App step, for the organization acme, with its webhook: GitHub refuses the webhook URL.
    await page.getByLabel("The GitHub organization that owns the App").fill("acme");
    await Promise.all([page.waitForURL(/\/setup\?/), page.getByRole("button", { name: "Apply" }).click()]);
    await expect(page.getByText("GitHub may refuse the webhook URL").count()).resolves.toBe(1);
    await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Invalid GitHub App configuration");
    await expect(page.locator("li.error").allTextContents()).resolves.toEqual([
      "Hook url is not supported because it isn't reachable over the public Internet (tiehall.example.com)",
      "Hook is invalid",
    ]);
    expect(stub.apps()).toEqual([]);

    // Back to the setup screen in the same browser: the App step, without the setup code.
    await page.goto(`${INSTALL}/setup`);
    await expect(page.getByLabel("Setup code").count()).resolves.toBe(0);
    await page.getByLabel("The GitHub organization that owns the App").fill("acme");
    await page.getByLabel("GitHub cannot reach this address").check();
    await Promise.all([page.waitForURL(/unreachable=1/), page.getByRole("button", { name: "Apply" }).click()]);
    await expect(page.getByText("The App is created without a webhook").count()).resolves.toBe(1);
    await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);

    // GitHub's confirmation page, then back to the setup screen, which sends the operator on to install the App.
    await Promise.all([page.waitForURL(`${INSTALL}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);
    await expect(page.getByRole("heading", { level: 2 }).textContent()).resolves.toBe("Install the GitHub App");

    const [app] = stub.apps();
    expect(stub.apps()).toHaveLength(1);
    expect(app?.hook).toBeNull();
    expect(app?.events).toEqual([]);
    expect((await owner.query("SELECT app_id, owner_login FROM github_app")).rows).toEqual([{ app_id: String(app?.id), owner_login: "acme" }]);
    expect((await owner.query("SELECT name FROM integration_secrets ORDER BY name")).rows.map(({ name }) => name as string)).toEqual([
      "github_app.client_secret",
      "github_app.private_key",
    ]);
    await context.close();
  });
});
