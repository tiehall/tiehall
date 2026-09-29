import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { createTestDatabase, dumpDatabase, type TestDatabase } from "@tiehall/testing/postgres";
import {
  buildAppManifest,
  createLogger,
  createSetupRoute,
  migrate,
  openDatabase,
  openSecretBox,
  readSecret,
  startSetup,
  type Database,
  type SecretBox,
} from "../src/index.ts";

// The App step of the setup screen (self-host-install: The GitHub App is
// created with GitHub's manifest flow; design.md, Self-hosting decisions: S4;
// github-app-reachability: design.md, Design rules: The webhook and the
// install URL, and An App without a webhook). With a setup session, the
// screen builds the App's manifest from the install's URL, the name the
// operator may edit and the option that GitHub cannot reach the install, and
// its one button posts it to the new-App page of the organization the
// operator names, or to their personal one, with a state bound to the setup
// session. GitHub sends the operator back with a code, which Tiehall converts
// at once, within the hour GitHub allows, and stores the App's credentials
// encrypted; a return whose state is missing or not bound to the browser's
// setup session is refused and stores nothing. Every GitHub page here is the
// GitHub stub's, reached over HTTP as a browser would post its forms.

const migrationsFolder = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const INSTALL = "https://tiehall.example.com";
const TRIAL = "http://localhost:3000";

let database: TestDatabase;
let owner: pg.Client;
let db: Database;
let stub: GitHubStub;
let box: SecretBox;
const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
const logger = createLogger({ write: () => {} });

beforeAll(async () => {
  database = await createTestDatabase();
  owner = new pg.Client({ connectionString: database.url });
  await owner.connect();
  await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
  const url = new URL(database.url);
  url.username = appRole.name;
  url.password = "";
  db = openDatabase({ connectionString: url.toString(), password: appRole.password });
  box = openSecretBox(randomBytes(32).toString("base64url"));
});

afterAll(async () => {
  await db.$client.end();
  await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
  await owner.end();
  await database.drop();
});

beforeEach(async () => {
  clock = () => new Date();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  // The browser that follows the setup screen to GitHub is signed in to GitHub as Omar.
  stub.signIn("omar");
});

afterEach(async () => {
  await stub.close();
  await owner.query(
    "DELETE FROM integration_secrets; DELETE FROM github_app; DELETE FROM setup_sessions; DELETE FROM setup_codes; DELETE FROM orgs",
  );
});

/** The setup screen's clock, which a test moves on; the system clock otherwise. */
let clock: () => Date = () => new Date();

const route = (url: string) =>
  createSetupRoute({ database: db, url, logger, secrets: () => box, github: { webUrl: stub.webUrl, apiUrl: stub.apiUrl }, now: () => clock() });

/** A browser's request to the install at this URL, as the web role's request guard hands it on, with the browser's cookie. */
function browserRequest(url: string, path: string, cookie?: string, init: RequestInit = {}): Request {
  const { host, protocol } = new URL(url);
  return new Request(`${url}${path}`, {
    ...init,
    headers: { host, "x-forwarded-proto": protocol.slice(0, -1), ...(cookie === undefined ? {} : { cookie }), ...(init.headers as Record<string, string>) },
  });
}

/** Starts the web role's setup step, enters its code and names the company, as the operator does; returns the browser's session cookie. */
async function setupSession(url: string): Promise<string> {
  const started = await startSetup({ database: db, url, logger });
  const answer = await route(url)(
    browserRequest(url, "/setup", undefined, {
      method: "POST",
      headers: { origin: url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: started?.code ?? "" }).toString(),
    }),
  );
  expect(answer.status).toBe(303);
  const cookie = (answer.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  // The company is named first; the App step follows.
  const named = await route(url)(
    browserRequest(url, "/setup/company", cookie, {
      method: "POST",
      headers: { origin: url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Acme" }).toString(),
    }),
  );
  expect(named.status).toBe(303);
  return cookie;
}

/** The setup screen, as the browser with this cookie sees it, with the App step's settings in its query. */
async function open(url: string, cookie: string | undefined, query: Record<string, string> = {}): Promise<{ status: number; html: string; headers: Headers }> {
  const search = new URLSearchParams(query).toString();
  const answer = await route(url)(browserRequest(url, `/setup${search === "" ? "" : `?${search}`}`, cookie));
  return { status: answer.status, html: await answer.text(), headers: answer.headers };
}

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** The form whose one button posts the manifest to GitHub: where it posts, and the manifest it carries. */
function createForm(html: string): { action: URL; manifest: Record<string, unknown>; index: number } | undefined {
  const match = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(html);
  if (match === null) return undefined;
  return { action: new URL(unescapeHtml(match[1] ?? "")), manifest: JSON.parse(unescapeHtml(match[2] ?? "")) as Record<string, unknown>, index: match.index };
}

/**
 * Posts the manifest to GitHub's new-App page as the browser does, and
 * confirms the App on GitHub's page; returns where GitHub sends the browser,
 * or GitHub's refusal page.
 */
async function createOnGitHub(form: { action: URL; manifest: Record<string, unknown> }): Promise<{ location?: URL; refusal?: string }> {
  const page = await fetch(form.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ manifest: JSON.stringify(form.manifest) }).toString(),
    redirect: "manual",
  });
  const html = await page.text();
  const registration = /name="registration" value="([^"]+)"/.exec(html)?.[1];
  if (registration === undefined) return { refusal: html };
  const confirmed = await fetch(`${stub.webUrl}/settings/apps/new/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ registration }).toString(),
    redirect: "manual",
  });
  expect(confirmed.status).toBe(302);
  return { location: new URL(confirmed.headers.get("location") ?? "") };
}

/** GitHub's redirect back to the setup screen, followed by the browser with this cookie. */
function returnFromGitHub(url: string, location: URL, cookie: string | undefined): Promise<Response> {
  return route(url)(browserRequest(url, `${location.pathname}${location.search}`, cookie));
}

async function storedApp() {
  return (await owner.query("SELECT app_id, slug, name, client_id, owner_login, owner_type FROM github_app")).rows;
}

async function storedSecretNames(): Promise<string[]> {
  return (await owner.query<{ name: string }>("SELECT name FROM integration_secrets ORDER BY name")).rows.map(({ name }) => name);
}

async function secret(name: "github_app.client_secret" | "github_app.private_key" | "github_app.webhook_secret") {
  const orgId = (await owner.query<{ id: string }>("SELECT id FROM orgs")).rows[0]?.id ?? "";
  return db.transaction((tx) => readSecret({ tx, orgId }, box, name));
}

function conversions() {
  return stub.received.filter((request) => request.host === "api" && /^\/app-manifests\/[^/]+\/conversions$/.test(request.path));
}

describe("the App step", () => {
  it("needs a setup session: without one the setup screen asks for the code and offers no manifest", async () => {
    await startSetup({ database: db, url: INSTALL, logger });
    const { html } = await open(INSTALL, undefined, { org: "acme" });
    expect(html).toContain('name="code"');
    expect(createForm(html)).toBeUndefined();
  });

  it("posts the manifest to the new-App page of the organization the operator names, with a state", async () => {
    const cookie = await setupSession(INSTALL);
    const form = createForm((await open(INSTALL, cookie, { org: "acme" })).html);
    expect(form?.action.origin).toBe(stub.webUrl);
    expect(form?.action.pathname).toBe("/organizations/acme/settings/apps/new");
    // A random nonce, the time it was issued, and an HMAC of both keyed by the setup session's token.
    expect(form?.action.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(form?.manifest).toEqual(buildAppManifest({ url: INSTALL, name: "Tiehall tiehall.example.com", unreachable: false }));
  });

  it("posts to the operator's personal new-App page when they name no organization, and recommends naming one", async () => {
    const cookie = await setupSession(INSTALL);
    const { html } = await open(INSTALL, cookie);
    expect(html).toContain("recommended");
    expect(createForm(html)?.action.pathname).toBe("/settings/apps/new");
  });

  it('takes the App\'s default name from "Tiehall" and the host, and the name the operator edits', async () => {
    const cookie = await setupSession(INSTALL);
    const edited = createForm((await open(INSTALL, cookie, { org: "acme", name: "Tiehall Acme" })).html);
    expect(edited?.manifest["name"]).toBe("Tiehall Acme");
    const trial = await setupSession(TRIAL);
    expect(createForm((await open(TRIAL, trial)).html)?.manifest["name"]).toBe("Tiehall localhost");
  });

  it("offers no button for an organization name that cannot be a GitHub login, and says so", async () => {
    const cookie = await setupSession(INSTALL);
    const { html } = await open(INSTALL, cookie, { org: "acme/../evil" });
    expect(html).toContain("is not the name of a GitHub organization");
    expect(createForm(html)).toBeUndefined();
  });

  it("lets its page post forms only to the install and to GitHub, and never be framed", async () => {
    const cookie = await setupSession(INSTALL);
    const { headers, html } = await open(INSTALL, cookie, { org: "acme" });
    const policy = headers.get("content-security-policy") ?? "";
    expect(policy).toContain(`form-action 'self' ${stub.webUrl}`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
  });
});

describe("what the App step says the App gets (github-app-reachability 1.3)", () => {
  it("on a trial URL: no webhook and polling, and no option", async () => {
    const cookie = await setupSession(TRIAL);
    const { html } = await open(TRIAL, cookie);
    const form = createForm(html);
    expect(form?.manifest).not.toHaveProperty("hook_attributes");
    expect(html).not.toContain('name="unreachable"');
    const before = html.slice(0, form?.index);
    expect(before).toContain("The App is created without a webhook");
    expect(before).toContain("GitHub runs in polling mode");
  });

  it("on any other URL: the option is offered and off, and the text before the button gives the way back", async () => {
    const cookie = await setupSession(INSTALL);
    const { html } = await open(INSTALL, cookie, { org: "acme" });
    expect(html).toContain('<input id="unreachable" name="unreachable" type="checkbox" value="1">');
    expect(html).toContain("GitHub cannot reach this address");
    const form = createForm(html);
    expect(form?.manifest["hook_attributes"]).toEqual({ url: `${INSTALL}/webhooks/github`, active: true });
    const before = html.slice(0, form?.index);
    expect(before).toContain(`GitHub may refuse the webhook URL, ${INSTALL}/webhooks/github, if it cannot reach this address`);
    expect(before).toContain(`open ${INSTALL}/setup again in this browser`);
    expect(before).toContain("choose &#34;GitHub cannot reach this address&#34;");
    expect(before).not.toContain("The App is created without a webhook");
  });

  it("with the option chosen: no webhook, polling, and webhook mode later from the admin page", async () => {
    const cookie = await setupSession(INSTALL);
    const { html } = await open(INSTALL, cookie, { org: "acme", unreachable: "1" });
    expect(html).toContain('<input id="unreachable" name="unreachable" type="checkbox" value="1" checked>');
    const form = createForm(html);
    expect(form?.manifest).not.toHaveProperty("hook_attributes");
    expect(form?.manifest["default_events"]).toEqual([]);
    const before = html.slice(0, form?.index);
    expect(before).toContain("The App is created without a webhook");
    expect(before).toContain("GitHub runs in polling mode");
    expect(before).toContain("An admin can move to webhook mode later from the admin page");
    expect(before).not.toContain("GitHub may refuse the webhook URL");
  });
});

describe("GitHub's return with the code", () => {
  it("converts the code at once and stores the App's credentials encrypted, then sends the operator on to install the App", async () => {
    const cookie = await setupSession(INSTALL);
    const form = createForm((await open(INSTALL, cookie, { org: "acme" })).html)!;
    const { location } = await createOnGitHub(form);
    expect(location?.href.startsWith(`${INSTALL}/setup/github?`)).toBe(true);
    expect(location?.searchParams.get("state")).toBe(form.action.searchParams.get("state"));
    expect(conversions()).toHaveLength(0);

    const answer = await returnFromGitHub(INSTALL, location!, cookie);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`${INSTALL}/setup`);
    // The code is converted when the operator comes back, well within the hour GitHub allows.
    expect(conversions().map(({ status }) => status)).toEqual([201]);

    const [app] = stub.apps();
    expect(await storedApp()).toEqual([
      { app_id: String(app!.id), slug: app!.slug, name: "Tiehall tiehall.example.com", client_id: app!.clientId, owner_login: "acme", owner_type: "Organization" },
    ]);
    expect(await secret("github_app.client_secret")).toBe(app!.clientSecret);
    expect(await secret("github_app.private_key")).toBe(app!.pem);
    expect(await secret("github_app.webhook_secret")).toBe(app!.webhookSecret);
    // Encrypted: the database holds none of them in clear.
    const dump = dumpDatabase(database.url, "plain").toString("utf8");
    for (const value of [app!.clientSecret, app!.webhookSecret ?? "", app!.pem.split("\n")[1] ?? ""]) {
      expect(value.length).toBeGreaterThan(10);
      expect(dump).not.toContain(value);
    }

    const next = await open(INSTALL, cookie);
    expect(next.html).toContain(`href="${stub.webUrl}/apps/${app!.slug}/installations/new"`);
    expect(createForm(next.html)).toBeUndefined();
  });

  it("stores an App on the operator's personal account as owned by a user", async () => {
    const cookie = await setupSession(INSTALL);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie)).html)!);
    expect((await returnFromGitHub(INSTALL, location!, cookie)).status).toBe(303);
    expect(await storedApp()).toEqual([expect.objectContaining({ owner_login: "omar", owner_type: "User" })]);
  });

  it("stores a trial install's App, which has no webhook, without a webhook secret", async () => {
    const cookie = await setupSession(TRIAL);
    const { location } = await createOnGitHub(createForm((await open(TRIAL, cookie)).html)!);
    expect(location?.href.startsWith(`${TRIAL}/setup/github?`)).toBe(true);
    expect((await returnFromGitHub(TRIAL, location!, cookie)).status).toBe(303);
    const [app] = stub.apps();
    expect(app?.webhookSecret).toBeNull();
    // Its id, slug, name, client id and owner, its client secret and its private key, and no webhook secret.
    expect(await storedApp()).toEqual([
      { app_id: String(app!.id), slug: app!.slug, name: "Tiehall localhost", client_id: app!.clientId, owner_login: "omar", owner_type: "User" },
    ]);
    expect(await storedSecretNames()).toEqual(["github_app.client_secret", "github_app.private_key"]);
    expect(await secret("github_app.client_secret")).toBe(app!.clientSecret);
    expect(await secret("github_app.private_key")).toBe(app!.pem);
    expect(await secret("github_app.webhook_secret")).toBeUndefined();
  });

  it("refuses a return without a state, converts nothing and stores nothing", async () => {
    const cookie = await setupSession(INSTALL);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie, { org: "acme" })).html)!);
    location!.searchParams.delete("state");
    const answer = await returnFromGitHub(INSTALL, location!, cookie);
    expect(answer.status).toBe(403);
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
    expect(conversions()).toHaveLength(0);
    expect(await storedApp()).toEqual([]);
    expect(await storedSecretNames()).toEqual([]);
  });

  it("refuses a state bound to another browser's setup session, one that was changed, and a return to a browser with no session", async () => {
    const cookie = await setupSession(INSTALL);
    const other = await setupSession(INSTALL);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, other, { org: "acme" })).html)!);
    const tampered = new URL(location!);
    // Its last character changed to another one, whatever it was.
    const state = location!.searchParams.get("state")!;
    tampered.searchParams.set("state", `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`);
    for (const [url, browser] of [
      [location!, cookie],
      [tampered, other],
      [location!, undefined],
    ] as const) {
      expect((await returnFromGitHub(INSTALL, url, browser)).status).toBe(403);
    }
    expect(conversions()).toHaveLength(0);
    expect(await storedApp()).toEqual([]);
    expect(await storedSecretNames()).toEqual([]);
  });

  // A state outlives nothing it protects: GitHub converts a manifest's code only within the hour, so an older
  // state is refused as foreign, before GitHub is asked; and a state that stored an App is used up.
  it("refuses a state issued more than 60 minutes ago as foreign, before asking GitHub, and stores nothing", async () => {
    const cookie = await setupSession(INSTALL);
    const issued = Date.now();
    clock = () => new Date(issued);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie, { org: "acme" })).html)!);
    clock = () => new Date(issued + 60 * 60 * 1000 + 1000);
    const answer = await returnFromGitHub(INSTALL, location!, cookie);
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/forbidden" });
    expect(conversions()).toHaveLength(0);
    expect(await storedApp()).toEqual([]);
  });

  it("takes a state until 60 minutes after it was issued", async () => {
    const cookie = await setupSession(INSTALL);
    const issued = Date.now();
    clock = () => new Date(issued);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie, { org: "acme" })).html)!);
    clock = () => new Date(issued + 59 * 60 * 1000);
    expect((await returnFromGitHub(INSTALL, location!, cookie)).status).toBe(303);
    expect(await storedApp()).toHaveLength(1);
  });

  it("refuses a second return with a state that stored an App already, before asking GitHub, and keeps the App", async () => {
    const cookie = await setupSession(INSTALL);
    const form = createForm((await open(INSTALL, cookie, { org: "acme" })).html)!;
    const first = await createOnGitHub(form);
    expect((await returnFromGitHub(INSTALL, first.location!, cookie)).status).toBe(303);
    const stored = await storedApp();
    expect(stored).toHaveLength(1);

    // The same page's form, posted again, as from an older tab: GitHub creates another App and returns the same state.
    const second = await createOnGitHub({ ...form, manifest: { ...form.manifest, name: "Tiehall second tab" } });
    expect(second.location?.searchParams.get("state")).toBe(form.action.searchParams.get("state"));
    const answer = await returnFromGitHub(INSTALL, second.location!, cookie);
    expect(answer.status).toBe(403);
    expect(conversions()).toHaveLength(1);
    expect(await storedApp()).toEqual(stored);
  });

  it("stores nothing when GitHub no longer converts the code, and says to create the App again", async () => {
    const cookie = await setupSession(INSTALL);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie, { org: "acme" })).html)!);
    // GitHub converts a manifest's code only within the hour.
    stub.advanceClock(61 * 60 * 1000);
    const answer = await returnFromGitHub(INSTALL, location!, cookie);
    expect(answer.status).toBe(502);
    expect(await answer.text()).toContain("create the App again");
    expect(conversions().map(({ status }) => status)).toEqual([404]);
    expect(await storedApp()).toEqual([]);
    expect(await storedSecretNames()).toEqual([]);
  });

  it("answers 404 once setup is complete", async () => {
    const cookie = await setupSession(INSTALL);
    const { location } = await createOnGitHub(createForm((await open(INSTALL, cookie, { org: "acme" })).html)!);
    await owner.query("UPDATE orgs SET name = 'Acme', setup_completed_at = now()");
    expect((await returnFromGitHub(INSTALL, location!, cookie)).status).toBe(404);
    expect(conversions()).toHaveLength(0);
  });
});
