import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  isSetupSession,
  newPersonalAccessToken,
  openSetupSession,
  personalAccessTokenHash,
  reconcileTrustState,
  reopenSetup,
  SetupRequiredError,
} from "../src/index.ts";
import { startAppServer, type AppServer } from "./support/app-server.ts";
import { CookieJar } from "./support/sign-in.ts";

// `setup reopen` (self-host-install: Operator commands on the host; sign-in:
// Who may sign in; self-host-install: The setup code guards the setup screen;
// tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// design.md, Self-hosting decisions: S3; github-app-reachability: design.md,
// Design rules: Finding installations and An App without a webhook). The
// operator runs it on the host through the image's admin role, for example
// after the App's credentials leaked: it reopens the setup screen's GitHub App
// step and prints a new setup code, and each run is a security event that
// names the command and no user. While the step is open, the install keeps
// serving its members, web sessions and tokens with the App in use, until the
// setup screen stores a new App's credentials, which replace the old App's:
// the old App's installations are no longer connected, and GitHub's mode
// follows the new App. The step closes only when a person who is already an
// admin signs in with GitHub from the setup session; anyone else gets 403.
// Closing it makes nobody an admin; with a new App it connects every
// installation the new App's listing holds, and with the App in use it
// connects none. Members, teams, roles, web sessions, agent grants and
// personal access tokens stay as they were. Each test builds a fresh install,
// so the tests have a timeout that holds on a slower runner.

let stub: GitHubStub;
let server: AppServer | undefined;

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addUser({ login: "dana" });
  stub.addUser({ login: "kim" });
  stub.addOrg({ login: "acme", members: { omar: "admin", dana: "member" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await stub.close();
});

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

/** A browser that entered this setup code. */
async function enterCode(install: AppServer, code: string): Promise<Browser> {
  const operator = browser(install);
  expect((await operator.post("/setup", { code })).status).toBe(303);
  return operator;
}

/**
 * Creates an App on acme through the setup screen's App step, as this
 * browser, which holds a setup session: with the step's query, such as the
 * option that GitHub cannot reach the install, and a name of its own, since
 * App names are unique on GitHub.
 */
async function createAppFromStep(operator: Browser, query: Record<string, string>): Promise<StubApp> {
  const html = await (await operator.get(`/setup?${new URLSearchParams({ org: "acme", ...query })}`)).text();
  const form = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="manifest" value="([^"]*)">/.exec(html);
  if (form === null) throw new Error(`the App step offers no manifest form:\n${html}`);
  const action = new URL(unescapeHtml(form[1] ?? ""));
  const state = action.searchParams.get("state") ?? "";
  const created = await stub.createAppFromManifest({ manifest: unescapeHtml(form[2] ?? ""), org: "acme", state, as: "omar" });
  if (created.status !== "created") throw new Error(`the stub refused the manifest: ${created.messages.join(" ")}`);
  expect((await operator.get(`/setup/github?${new URLSearchParams({ code: created.code, state })}`)).status).toBe(303);
  return created.app;
}

/** A sign-in with GitHub from the setup screen, as this GitHub user, with the App the install uses now. */
async function signInFromSetup(operator: Browser, app: StubApp, login: string): Promise<Response> {
  const started = await operator.post("/setup/sign-in", {});
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const code = stub.authorize(app, login, { redirectUri, codeChallenge: authorize.searchParams.get("code_challenge") ?? "" });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return operator.get(back.href, { "x-forwarded-for": "203.0.113.7", "user-agent": "Omar's browser", accept: "text/html" });
}

/** The usual sign-in with GitHub, from the sign-in page, as this GitHub user, with the App the install uses now. */
async function signIn(install: AppServer, app: StubApp, login: string): Promise<{ response: Response; person: Browser }> {
  const person = browser(install);
  const started = await person.post("/sign-in", { return: "/" });
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
  const code = stub.authorize(app, login, { redirectUri, codeChallenge: authorize.searchParams.get("code_challenge") ?? "" });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return { response: await person.get(back.href), person };
}

interface Completed {
  install: AppServer;
  app: StubApp;
  /** Omar's browser, signed in as the install's first admin. */
  omar: Browser;
}

/**
 * An install whose setup Omar completed: company Acme, an App on acme, with a
 * webhook unless the option is chosen, installed on acme and connected, and
 * Omar its first admin.
 */
async function completeSetup(options: { unreachable?: boolean } = {}): Promise<Completed> {
  const install = await startAppServer(stub);
  server = install;
  const operator = await enterCode(install, await install.start());
  expect((await operator.post("/setup/company", { name: "Acme" })).status).toBe(303);
  const app = await createAppFromStep(operator, options.unreachable === true ? { unreachable: "1" } : {});
  await stub.install(app, { account: "acme", repositories: ["acme/web"] });
  expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);
  return { install, app, omar: operator };
}

async function members(install: AppServer): Promise<{ login: string; role: string }[]> {
  const { rows } = await install.owner.query<{ login: string; role: string }>(
    "SELECT u.github_login AS login, m.role FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id ORDER BY 1",
  );
  return rows;
}

/** The installations Tiehall acts on, by their account, with the App they belong to. */
async function connected(install: AppServer): Promise<{ app_id: string; account: string }[]> {
  const { rows } = await install.owner.query<{ app_id: string; account: string }>(
    `SELECT i.app_id::text, i.account_login AS account FROM github_connected_installations c
       JOIN github_installations i ON i.org_id = c.org_id AND i.id = c.installation_id ORDER BY 1, 2`,
  );
  return rows;
}

async function reopened(install: AppServer): Promise<boolean> {
  return (await install.owner.query<{ open: boolean }>("SELECT setup_reopened_at IS NOT NULL AS open FROM orgs")).rows[0]?.open ?? false;
}

async function lastEvent(install: AppServer): Promise<number> {
  return Number((await install.owner.query<{ last: string | null }>("SELECT max(number) AS last FROM events")).rows[0]?.last ?? 0);
}

async function eventsAfter(install: AppServer, number: number) {
  const { rows } = await install.owner.query<{ type: string; actor_kind: string; operator_command: string | null; actor_user_id: string | null; data: unknown }>(
    "SELECT type, actor_kind, operator_command, actor_user_id, data FROM events WHERE number > $1 ORDER BY number",
    [number],
  );
  return rows;
}

/** What stays as it was through a reopened step: members and their roles, teams, sessions, grants and tokens. */
async function trustState(install: AppServer): Promise<unknown> {
  const query = async (text: string) => (await install.owner.query(text)).rows;
  return {
    members: await query("SELECT user_id, role FROM members ORDER BY user_id"),
    teams: await query("SELECT id, key, name FROM teams ORDER BY id"),
    teamMembers: await query("SELECT team_id, user_id FROM team_members ORDER BY team_id, user_id"),
    sessions: await query("SELECT id, user_id, ended_at FROM web_sessions ORDER BY id"),
    grants: await query("SELECT id, user_id FROM oauth_consents ORDER BY id"),
    tokens: await query("SELECT id, user_id, revoked_at FROM personal_access_tokens ORDER BY id"),
  };
}

/** A personal access token of this member's, as the tokens page creates one, and its value. */
async function personalAccessTokenOf(install: AppServer, login: string): Promise<string> {
  const value = newPersonalAccessToken();
  await install.owner.query(
    `INSERT INTO personal_access_tokens (org_id, user_id, name, scopes, token_hash, created_at, expires_at)
       SELECT u.org_id, u.id, 'laptop', ARRAY['requests:read'], $2, now(), now() + interval '30 days' FROM users u WHERE u.github_login = $1`,
    [login, personalAccessTokenHash(value)],
  );
  return value;
}

describe("setup reopen", { timeout: 90_000 }, () => {
  it("prints a new setup code, records a security event naming the command and no user, and the install keeps serving members, sessions and tokens with the App in use", async () => {
    const { install, app, omar } = await completeSetup();
    const { person: dana } = await signIn(install, app, "dana");
    const token = await personalAccessTokenOf(install, "dana");
    const before = await lastEvent(install);
    const state = await trustState(install);

    const { code } = await reopenSetup(install.db);

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    expect(await reopened(install)).toBe(true);
    expect(await eventsAfter(install, before)).toEqual([
      { type: "setup.reopened", actor_kind: "operator", operator_command: "setup reopen", actor_user_id: null, data: { alreadyOpen: false } },
    ]);
    // The install keeps serving: pages, web sessions, the usual sign-in with the App in use, and tokens.
    expect((await omar.get("/", { accept: "text/html" })).status).toBe(200);
    expect(await install.signIn.session(new Headers({ cookie: dana.jar.header() }))).toMatchObject({ kind: "web_session" });
    expect((await signIn(install, app, "dana")).response.status).toBe(302);
    const whoami = await install.handle(new Request(`${install.url}/api/v1/whoami`, { headers: { authorization: `Bearer ${token}` } }));
    expect(whoami.status).toBe(200);
    expect(await connected(install)).toEqual([{ app_id: String(app.id), account: "acme" }]);
    // /setup no longer answers 404, and the new code leads to the GitHub App step.
    const operator = await enterCode(install, code);
    const step = await (await operator.get("/setup")).text();
    expect(step).toContain("Create a new GitHub App");
    expect(step).toContain("Keep the App in use");
    const after = (await trustState(install)) as { sessions: unknown[] };
    // Dana's sign-in above added a session; everything else is as it was.
    expect({ ...after, sessions: (state as { sessions: unknown[] }).sessions }).toEqual(state);
  });

  it("opens only the App step: the company's name stays as it was", async () => {
    const { install } = await completeSetup();
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);
    await expect((await operator.get("/setup?step=company")).text()).resolves.not.toContain("Name the company");
    expect((await operator.post("/setup/company", { name: "Acme Corp" })).status).toBe(404);
    expect((await install.owner.query("SELECT name FROM orgs")).rows).toEqual([{ name: "Acme" }]);
  });

  it("prints no code at a start of the app while the step is open, and the code the command printed keeps working", async () => {
    const { install } = await completeSetup();
    const { code } = await reopenSetup(install.db);
    await expect(install.start()).rejects.toThrow("setup is complete");
    expect(await openSetupSession(install.db, code)).toBeDefined();
  });

  it("run again, prints another code that replaces the first, keeps the sessions opened with it, and records the run", async () => {
    const { install } = await completeSetup();
    const first = await reopenSetup(install.db);
    const operator = await enterCode(install, first.code);
    const before = await lastEvent(install);

    const second = await reopenSetup(install.db);

    expect(second.code).not.toBe(first.code);
    expect(await openSetupSession(install.db, first.code)).toBeUndefined();
    expect((await operator.get("/setup")).status).toBe(200);
    expect((await eventsAfter(install, before)).map(({ type, data }) => ({ type, data }))).toEqual([{ type: "setup.reopened", data: { alreadyOpen: true } }]);
  });

  it("changes nothing and records nothing before setup completes, when the setup screen is open already", async () => {
    const install = await startAppServer(stub);
    server = install;
    await install.start();
    await expect(reopenSetup(install.db)).rejects.toBeInstanceOf(SetupRequiredError);
    expect((await install.owner.query("SELECT count(*)::int AS count FROM events")).rows).toEqual([{ count: 0 }]);
  });
});

describe("the step setup reopen opened", { timeout: 90_000 }, () => {
  it("refuses a sign-in from the setup session by a member who is not an admin with 403, and stays open", async () => {
    const { install, app } = await completeSetup();
    await signIn(install, app, "dana");
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);
    const before = await lastEvent(install);

    const answer = await signInFromSetup(operator, app, "dana");

    expect(answer.status).toBe(403);
    const page = await answer.text();
    expect(page).toContain("sign-in-refused");
    expect(page).toContain("Only an admin of the install");
    expect(await reopened(install)).toBe(true);
    expect((await operator.get("/setup")).status).toBe(200);
    expect(await members(install)).toEqual([
      { login: "dana", role: "member" },
      { login: "omar", role: "admin" },
    ]);
    // The refusal is a refused sign-in, and no session is stored for it.
    expect((await eventsAfter(install, before)).map(({ type }) => type)).toEqual(["sign_in.refused"]);
    expect(await install.signIn.session(new Headers({ cookie: operator.jar.header() }))).toBeUndefined();
  });

  it("refuses a person who is no member at all, and creates no user for them", async () => {
    const { install, app } = await completeSetup();
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);
    const users = (await install.owner.query("SELECT count(*)::int AS count FROM users")).rows;

    expect((await signInFromSetup(operator, app, "kim")).status).toBe(403);

    expect((await install.owner.query("SELECT count(*)::int AS count FROM users")).rows).toEqual(users);
    expect(await reopened(install)).toBe(true);
  });

  it("closes when an admin signs in from the setup session with the App in use: nobody becomes an admin, none is connected, and /setup answers 404", async () => {
    const { install, app } = await completeSetup();
    await signIn(install, app, "dana");
    const code = (await reopenSetup(install.db)).code;
    const operator = await enterCode(install, code);
    // Omar disconnected the installation on acme before; closing with the App in use leaves it so.
    await install.owner.query("DELETE FROM github_connected_installations");
    const before = await lastEvent(install);

    // The step serves the setup screen's sign-in again (github-layer-hardening 1.2).
    const answer = await signInFromSetup(operator, app, "omar");

    expect(answer.status).toBe(302);
    expect(await reopened(install)).toBe(false);
    expect(await members(install)).toEqual([
      { login: "dana", role: "member" },
      { login: "omar", role: "admin" },
    ]);
    expect(await connected(install)).toEqual([]);
    expect((await eventsAfter(install, before)).map(({ type }) => type)).toEqual(["sign_in.completed"]);
    // The step is closed for good: /setup, the setup screen's sign-in and GitHub's return to it answer 404, and the code opens nothing.
    for (const path of ["/setup", "/setup/sign-in/callback/github?code=x&state=y"]) expect((await operator.get(path)).status).toBe(404);
    expect((await operator.post("/setup/sign-in", {})).status).toBe(404);
    expect(await openSetupSession(install.db, code)).toBeUndefined();
    expect((await install.owner.query("SELECT (SELECT count(*) FROM setup_sessions)::int AS sessions, (SELECT count(*) FROM setup_codes)::int AS codes")).rows).toEqual([
      { sessions: 0, codes: 0 },
    ]);
    // Omar is signed in, and the setup cookie is dropped.
    expect(await install.signIn.session(new Headers({ cookie: operator.jar.header() }))).toMatchObject({ kind: "web_session" });
    expect(operator.jar.names()).not.toContain("__Host-tiehall-setup");
  });

  it("with a new App: deletes the old App's credentials, disconnects its installations, connects only the new App's when an admin closes it, and keeps members, teams, roles, grants and tokens", async () => {
    const { install, app: oldApp, omar } = await completeSetup();
    await signIn(install, oldApp, "dana");
    await personalAccessTokenOf(install, "dana");
    await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'FE', 'Frontend' FROM orgs");
    const state = await trustState(install);
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);
    const before = await lastEvent(install);

    const newApp = await createAppFromStep(operator, { name: "Tiehall Acme Two" });

    // The new App's credentials replace the old App's at once, and the old App's installations are no longer connected.
    expect((await install.owner.query("SELECT app_id::text FROM github_app")).rows).toEqual([{ app_id: String(newApp.id) }]);
    expect(await connected(install)).toEqual([]);
    const secrets = (await install.owner.query<{ name: string }>("SELECT name FROM integration_secrets ORDER BY name")).rows.map(({ name }) => name);
    expect(secrets).toEqual(["github_app.client_secret", "github_app.private_key", "github_app.webhook_secret"]);
    const replacement = await eventsAfter(install, before);
    expect(replacement.map(({ type, actor_kind }) => ({ type, actor_kind }))).toEqual([
      { type: "github.app_replaced", actor_kind: "system" },
      { type: "github.installation_disconnected", actor_kind: "system" },
    ]);
    expect(replacement[0]?.data).toEqual({ app: newApp.id, previousApp: oldApp.id });
    // The install step names the replaced App, which stays registered on GitHub, and asks an admin to sign in.
    const step = await (await operator.get("/setup")).text();
    expect(step).toContain(`Install ${newApp.name} on GitHub`);
    expect(step).toContain(`${oldApp.name} in its settings on GitHub`);
    // Omar's web session, made with the old App, still works.
    expect((await omar.get("/", { accept: "text/html" })).status).toBe(200);

    await stub.install(newApp, { account: "acme", repositories: ["acme/web", "acme/api"] });
    const closing = await lastEvent(install);
    expect((await signInFromSetup(operator, newApp, "omar")).status).toBe(302);

    expect(await reopened(install)).toBe(false);
    expect(await connected(install)).toEqual([{ app_id: String(newApp.id), account: "acme" }]);
    const covered = (await install.owner.query("SELECT full_name FROM github_covered_repositories ORDER BY 1")).rows;
    expect(covered).toEqual([{ full_name: "acme/api" }, { full_name: "acme/web" }]);
    const closed = await eventsAfter(install, closing);
    expect(closed.map(({ type, actor_kind }) => ({ type, actor_kind }))).toEqual([
      { type: "github.installation_connected", actor_kind: "web_session" },
      { type: "sign_in.completed", actor_kind: "web_session" },
    ]);
    const after = (await trustState(install)) as { sessions: { id: string }[] };
    // Omar's sign-in from the setup screen added a session; every other session, member, role, team, grant and token is unchanged.
    const sessionsBefore = (state as { sessions: { id: string }[] }).sessions;
    expect(after.sessions.filter(({ id }) => sessionsBefore.some((session) => session.id === id))).toEqual(sessionsBefore);
    expect({ ...after, sessions: sessionsBefore }).toEqual(state);
    // The admin page lists the new App's installations only.
    const page = await (await omar.get("/admin/github", { accept: "text/html" })).text();
    expect(page).toContain("Disconnect acme");
    expect((page.match(/the App&#39;s installation on the organization acme/g) ?? []).length).toBe(1);
    // The nightly comparison finds nothing to add: no role changed without its event.
    await reconcileTrustState.handle({ id: "job", queue: reconcileTrustState.type.queue, data: {}, signal: new AbortController().signal }, { database: install.db, now: () => new Date() });
    expect((await install.owner.query("SELECT type FROM events WHERE type = 'activity_log.reconciled'")).rows).toEqual([]);
  });

  it("with a new App without a webhook that replaces one with a webhook: deletes the webhook secret, sets polling mode, and connects every installation the new App's listing holds (github-app-reachability 1.6)", async () => {
    const { install } = await completeSetup();
    expect((await install.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "webhook" }]);
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);

    const newApp = await createAppFromStep(operator, { name: "Tiehall Acme Two", unreachable: "1" });

    expect(newApp.hook).toBeNull();
    expect((await install.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "polling" }]);
    expect((await install.owner.query("SELECT name FROM integration_secrets WHERE name = 'github_app.webhook_secret'")).rows).toEqual([]);
    // A company with two GitHub organizations makes its App public, so it installs on both.
    stub.addOrg({ login: "acme-labs", members: { omar: "admin" } });
    stub.updateApp(newApp, { public: true });
    await stub.install(newApp, { account: "acme" });
    await stub.install(newApp, { account: "acme-labs", by: "omar" });
    install.sentJobs.length = 0;
    expect((await signInFromSetup(operator, newApp, "omar")).status).toBe(302);
    expect(await connected(install)).toEqual([
      { app_id: String(newApp.id), account: "acme" },
      { app_id: String(newApp.id), account: "acme-labs" },
    ]);
    // Polling mode's first poll comes as the step closes.
    expect(install.sentJobs).toContainEqual({ queue: "github.poll.v1", data: {} });
  });

  it("with a new App with a webhook that replaces one without: sets webhook mode (github-app-reachability 1.6)", async () => {
    const { install } = await completeSetup({ unreachable: true });
    expect((await install.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "polling" }]);
    const operator = await enterCode(install, (await reopenSetup(install.db)).code);

    const newApp = await createAppFromStep(operator, { name: "Tiehall Acme Two" });

    expect(newApp.hook).not.toBeNull();
    expect((await install.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "webhook" }]);
    expect((await install.owner.query("SELECT count(*)::int AS count FROM integration_secrets WHERE name = 'github_app.webhook_secret'")).rows).toEqual([{ count: 1 }]);
  });

  it("keeps a browser without the new code out, and ends every setup session once it closes", async () => {
    const { install, app } = await completeSetup();
    const { code } = await reopenSetup(install.db);
    const stranger = browser(install);
    expect((await stranger.post("/setup", { code: "0000-0000-0000-0000-0000-0000-0000" })).status).toBe(403);
    const operator = await enterCode(install, code);
    const other = await enterCode(install, code);
    expect((await signInFromSetup(operator, app, "omar")).status).toBe(302);
    const otherToken = /__Host-tiehall-setup=([^;]+)/.exec(other.jar.header())?.[1];
    expect(await isSetupSession(install.db, otherToken)).toBe(false);
    expect((await other.get("/setup")).status).toBe(404);
  });
});
