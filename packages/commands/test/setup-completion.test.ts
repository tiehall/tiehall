import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import { isSetupSession, openSetupSession, reconcileTrustState, releaseHeldGitHubDeliveries } from "../src/index.ts";
import { startAppServer, type AppServer } from "./support/app-server.ts";
import { CookieJar } from "./support/sign-in.ts";

// Naming the company and completing setup, without a browser
// (self-host-install: Setup names the company and makes the first admin;
// teams-and-roles: One org per install; sign-in: Who may sign in;
// activity-log: Which actions are security events; tracker-mirrors: Admins
// connect GitHub installations with the confirmation step;
// github-app-reachability: design.md, Design rules: Finding installations).
// The operator enters the setup code and names the company, which becomes the
// name of the install's one org; the setup screen creates the App through the
// stub's manifest flow; then a sign-in with GitHub from the browser that holds
// the setup session completes setup: its person becomes the first admin, the
// App's installations, found by listing them, are connected, the deliveries
// held during setup are released, and setup closes for good. setup-complete-
// browser.test.ts runs the same in a real browser. Each test builds a fresh
// install, migrations included, and one builds two, so the tests have a
// timeout that holds on a slower runner.

let stub: GitHubStub;
let server: AppServer | undefined;
/** Whether the stub's listing of the App's installations fails, as GitHub out of reach would. */
let listingFails = false;

beforeEach(async () => {
  listingFails = false;
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addUser({ login: "kim" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await stub.close();
});

async function start(options: { trial?: boolean } = {}): Promise<AppServer> {
  server = await startAppServer(stub, {
    ...options,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (listingFails && url.pathname === "/app/installations") return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      return fetch(input, init);
    }) as typeof fetch,
  });
  return server;
}

/** A browser at the install: its cookies, and its requests as the install answers them. */
function browser(install: AppServer, jar = new CookieJar()) {
  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (jar.header() !== "") headers.set("cookie", jar.header());
    const answer = await install.handle(new Request(path.startsWith("http") ? path : `${install.url}${path}`, { ...init, headers }));
    jar.take(answer);
    return answer;
  };
  return {
    jar,
    get: (path: string, headers: Record<string, string> = {}) => send(path, { headers }),
    post: (path: string, fields: Record<string, string>, origin = install.url) =>
      send(path, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      }),
  };
}

type Browser = ReturnType<typeof browser>;

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** The operator enters the setup code in a fresh browser. */
async function enterCode(install: AppServer): Promise<Browser> {
  const operator = browser(install);
  expect((await operator.post("/setup", { code: await install.start() })).status).toBe(303);
  return operator;
}

/** The operator enters the code, names the company and creates the App on acme through the manifest flow; returns the browser and the App. */
async function createApp(install: AppServer): Promise<{ operator: Browser; app: StubApp }> {
  const operator = await enterCode(install);
  expect((await operator.post("/setup/company", { name: "Acme" })).status).toBe(303);
  const html = await (await operator.get("/setup?org=acme")).text();
  const form = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(html);
  const action = new URL(unescapeHtml(form?.[1] ?? ""));
  const state = action.searchParams.get("state") ?? "";
  const created = await stub.createAppFromManifest({ manifest: unescapeHtml(form?.[2] ?? ""), org: "acme", state, as: "omar" });
  if (created.status !== "created") throw new Error(`the stub refused the manifest: ${created.messages.join(" ")}`);
  expect((await operator.get(`/setup/github?${new URLSearchParams({ code: created.code, state })}`)).status).toBe(303);
  return { operator, app: created.app };
}

/** A sign-in with GitHub from the setup screen, as this GitHub user; returns the install's answer to GitHub's return. */
async function signInFromSetup(operator: Browser, app: StubApp, login: string, callbackBrowser = operator): Promise<Response> {
  const started = await operator.post("/setup/sign-in", {});
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = authorize.searchParams.get("code_challenge") ?? undefined;
  const code = stub.authorize(app, login, { redirectUri, ...(codeChallenge === undefined ? {} : { codeChallenge }) });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return callbackBrowser.get(back.href, { "x-forwarded-for": "203.0.113.7", "user-agent": "Omar's browser" });
}

async function members(install: AppServer): Promise<{ login: string; role: string }[]> {
  const { rows } = await install.owner.query<{ login: string; role: string }>(
    "SELECT u.github_login AS login, m.role FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id ORDER BY 1",
  );
  return rows;
}

async function setupCompleted(install: AppServer): Promise<boolean> {
  const { rows } = await install.owner.query<{ completed: boolean }>("SELECT setup_completed_at IS NOT NULL AS completed FROM orgs");
  return rows[0]?.completed ?? false;
}

describe("naming the company", { timeout: 60_000 }, () => {
  it("names the install's org with the name the operator gives, trimmed, and lets them change it until setup completes", async () => {
    const install = await start();
    const operator = await enterCode(install);
    await expect((await operator.get("/setup")).text()).resolves.toContain("Name the company");

    expect((await operator.post("/setup/company", { name: "  Acme Inc  " })).status).toBe(303);
    expect((await install.owner.query("SELECT name FROM orgs")).rows).toEqual([{ name: "Acme Inc" }]);
    const next = await (await operator.get("/setup")).text();
    expect(next).toContain("Create the install's GitHub App");
    expect(next).toContain("The company: Acme Inc.");

    // Changing it: the form comes back with the name, and a new one replaces it.
    await expect((await operator.get("/setup?step=company")).text()).resolves.toContain('value="Acme Inc"');
    expect((await operator.post("/setup/company", { name: "Acme" })).status).toBe(303);
    expect((await install.owner.query("SELECT name FROM orgs")).rows).toEqual([{ name: "Acme" }]);
  });

  it("refuses an empty name, a name longer than 100 characters and one with a control character with 400, changing nothing", async () => {
    const install = await start();
    const operator = await enterCode(install);
    for (const name of ["", "   ", "x".repeat(101), "Acme\u0007"]) {
      const answer = await operator.post("/setup/company", { name });
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { type: string }).type).toBe("https://tiehall.com/problems/invalid-input");
    }
    expect((await operator.post("/setup/company", { name: "x".repeat(100) })).status).toBe(303);
    expect((await install.owner.query("SELECT length(name) AS length FROM orgs")).rows).toEqual([{ length: 100 }]);
  });

  it("refuses a name from another origin, or from a browser without a setup session, with 403", async () => {
    const install = await start();
    const operator = await enterCode(install);
    expect((await operator.post("/setup/company", { name: "Acme" }, "https://evil.example")).status).toBe(403);
    expect((await browser(install).post("/setup/company", { name: "Acme" })).status).toBe(403);
    expect((await install.owner.query("SELECT name FROM orgs")).rows).toEqual([{ name: null }]);
  });
});

describe("the sign-in that completes setup", { timeout: 60_000 }, () => {
  it("makes the person the first admin, connects every installation the listing holds, and records the completion naming them", async () => {
    // Also: each installation connected then is recorded as a security event, as an admin's connection is.
    const install = await start();
    const { operator, app } = await createApp(install);
    const installation = await stub.install(app, { account: "acme", repositories: ["acme/web"] });

    const answer = await signInFromSetup(operator, app, "omar");

    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("/");
    expect(await setupCompleted(install)).toBe(true);
    expect(await members(install)).toEqual([{ login: "omar", role: "admin" }]);
    const { rows: connected } = await install.owner.query<{ installation_id: string; covered: string[] }>(
      `SELECT i.installation_id, ARRAY(SELECT r.full_name FROM github_covered_repositories r WHERE r.org_id = i.org_id AND r.installation_id = i.id) AS covered
         FROM github_connected_installations c JOIN github_installations i ON i.org_id = c.org_id AND i.id = c.installation_id`,
    );
    expect(connected).toEqual([{ installation_id: String(installation.id), covered: ["acme/web"] }]);

    // The completion, then the sign-in, as security events naming Omar, with where they came from kept apart.
    const { rows: events } = await install.owner.query<{ type: string; login: string; actor_kind: string; ip_address: string; user_agent: string }>(
      `SELECT e.type, u.github_login AS login, e.actor_kind, host(o.ip_address) AS ip_address, o.user_agent
         FROM events e JOIN users u ON u.org_id = e.org_id AND u.id = coalesce(e.data->>'userId', e.actor_user_id::text)::uuid
         LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
        ORDER BY e.number`,
    );
    expect(events).toEqual([
      { type: "setup.completed", login: "omar", actor_kind: "web_session", ip_address: "203.0.113.7", user_agent: "Omar's browser" },
      { type: "github.installation_connected", login: "omar", actor_kind: "web_session", ip_address: "203.0.113.7", user_agent: "Omar's browser" },
      { type: "sign_in.completed", login: "omar", actor_kind: "web_session", ip_address: "203.0.113.7", user_agent: "Omar's browser" },
    ]);
    const { rows: connections } = await install.owner.query("SELECT e.data->>'installationId' AS installation FROM events e WHERE e.type = 'github.installation_connected'");
    const { rows: known } = await install.owner.query("SELECT id AS installation FROM github_installations");
    expect(connections).toEqual(known);

    // Omar is signed in, and the setup cookie is dropped.
    expect(await install.signIn.session(new Headers({ cookie: operator.jar.header() }))).toMatchObject({ kind: "web_session" });
    expect(operator.jar.names()).not.toContain("__Host-tiehall-setup");
  });

  it("closes setup for good: the code and every setup session open nothing, /setup answers 404, and the nightly comparison finds nothing to add", async () => {
    const install = await start();
    const { operator, app } = await createApp(install);
    const other = await enterCode(install);
    const code = await install.start();
    await stub.install(app, { account: "acme" });

    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);

    expect(await openSetupSession(install.db, code)).toBeUndefined();
    const otherToken = /__Host-tiehall-setup=([^;]+)/.exec(other.jar.header())?.[1];
    expect(await isSetupSession(install.db, otherToken)).toBe(false);
    for (const answer of [await other.get("/setup"), await other.post("/setup", { code }), await other.post("/setup/sign-in", {})]) expect(answer.status).toBe(404);
    expect((await install.owner.query("SELECT count(*)::int AS rows FROM setup_sessions")).rows).toEqual([{ rows: 0 }]);
    expect((await install.owner.query("SELECT count(*)::int AS rows FROM setup_codes")).rows).toEqual([{ rows: 0 }]);

    // The first admin's membership is recorded by the completion's event, so the comparison adds no reconciled event.
    await reconcileTrustState.handle({ id: "job", queue: reconcileTrustState.type.queue, data: {}, signal: new AbortController().signal }, { database: install.db, now: () => new Date() });
    expect((await install.owner.query("SELECT type FROM events WHERE type = 'activity_log.reconciled'")).rows).toEqual([]);
  });

  it("releases the deliveries held during setup at once, in the transaction that completes it", async () => {
    const install = await start();
    const { operator, app } = await createApp(install);
    await install.owner.query(
      `INSERT INTO github_deliveries (org_id, delivery_id, event, payload) SELECT id, 'held-delivery-1', 'installation', '{"action":"created"}' FROM orgs`,
    );
    await stub.install(app, { account: "acme" });

    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);

    expect(install.sentJobs).toContainEqual({ queue: "github.process_delivery.v1", data: { deliveryId: "held-delivery-1" } });
    expect((await install.owner.query("SELECT enqueued_at IS NOT NULL AS released FROM github_deliveries")).rows).toEqual([{ released: true }]);
    // The job that runs every minute finds nothing more to release.
    const before = install.sentJobs.length;
    await releaseHeldGitHubDeliveries.handle(
      { id: "job", queue: releaseHeldGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), jobs: { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) } },
    );
    expect(install.sentJobs).toHaveLength(before);
  });

  it("runs GitHub in the mode the App's credentials set, and sends the first poll of polling mode as it completes (github-app-reachability 1.7)", async () => {
    // On a trial URL the App has no webhook: polling mode, whose first poll the completion sends.
    const trial = await start({ trial: true });
    const { operator, app } = await createApp(trial);
    expect(app.hook).toBeNull();
    expect((await trial.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "polling" }]);
    await stub.install(app, { account: "acme" });

    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);

    expect(trial.sentJobs).toContainEqual({ queue: "github.poll.v1", data: {} });
    await trial.close();
    server = undefined;

    // At https://tiehall.example.com the App has a webhook: webhook mode, and no poll.
    const reachable = await start();
    const created = await createApp(reachable);
    expect(created.app.hook).not.toBeNull();
    expect((await reachable.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "webhook" }]);
    expect((await signInFromSetup(created.operator, created.app, "omar")).status).toBe(302);
    expect(reachable.sentJobs.map(({ queue }) => queue)).not.toContain("github.poll.v1");
  });

  it("completes with nothing connected when the App has no installation yet", async () => {
    const install = await start();
    const { operator, app } = await createApp(install);

    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);

    expect(await setupCompleted(install)).toBe(true);
    expect(await members(install)).toEqual([{ login: "omar", role: "admin" }]);
    expect((await install.owner.query("SELECT count(*)::int AS rows FROM github_connected_installations")).rows).toEqual([{ rows: 0 }]);
  });

  it("refuses GitHub's return to a browser without the setup session with 403: nobody joins and setup stays incomplete", async () => {
    const install = await start();
    const { operator, app } = await createApp(install);
    await stub.install(app, { account: "acme" });

    // The authorize page's return reaches a browser that holds the sign-in's state but no setup session.
    const elsewhere = browser(install, new CookieJar());
    const started = await operator.post("/setup/sign-in", {});
    for (const cookie of started.headers.getSetCookie()) elsewhere.jar.take(new Response(null, { headers: { "set-cookie": cookie } }));
    const authorize = new URL(started.headers.get("location") ?? "");
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    back.searchParams.set("code", stub.authorize(app, "kim", { redirectUri, codeChallenge: authorize.searchParams.get("code_challenge") ?? "" }));
    back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const answer = await elsewhere.get(back.href);

    expect(answer.status).toBe(403);
    expect(await setupCompleted(install)).toBe(false);
    expect(await members(install)).toEqual([]);
    expect((await install.owner.query("SELECT count(*)::int AS rows FROM web_sessions")).rows).toEqual([{ rows: 0 }]);
  });

  it("starts no sign-in before the company is named and the App is stored (409), from another origin or without a setup session (403)", async () => {
    const install = await start();
    const operator = await enterCode(install);
    expect((await operator.post("/setup/sign-in", {})).status).toBe(409);
    expect((await operator.post("/setup/company", { name: "Acme" })).status).toBe(303);
    expect((await operator.post("/setup/sign-in", {})).status).toBe(409);
    expect((await operator.post("/setup/sign-in", {}, "https://evil.example")).status).toBe(403);
    expect((await browser(install).post("/setup/sign-in", {})).status).toBe(403);
  });

  it("sends the operator back to the setup screen, with setup incomplete and no session, when GitHub cannot list the installations; a later sign-in completes it", async () => {
    const install = await start();
    const { operator, app } = await createApp(install);
    await stub.install(app, { account: "acme" });
    listingFails = true;

    const failed = await signInFromSetup(operator, app, "omar");

    expect(failed.status).toBe(302);
    expect(failed.headers.get("location")).toBe("/setup?error=github_failed&error_description=GitHub+could+not+be+reached+to+list+the+App%27s+installations.");
    expect(await setupCompleted(install)).toBe(false);
    expect(await members(install)).toEqual([]);
    expect((await install.owner.query("SELECT count(*)::int AS rows FROM web_sessions")).rows).toEqual([{ rows: 0 }]);
    await expect((await operator.get("/setup?error=github_failed")).text()).resolves.toContain("GitHub could not be reached to list the App&#39;s installations");

    listingFails = false;
    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);
    expect(await setupCompleted(install)).toBe(true);
    expect(await members(install)).toEqual([{ login: "omar", role: "admin" }]);
  });
});
