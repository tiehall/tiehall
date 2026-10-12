import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  createGitHubAdminRoute,
  csrfTokenFor,
  GITHUB_ADMIN_PATH,
  readInstallations,
  syncGitHubInstallations,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { storeStubApp } from "./support/github-app.ts";

// Connecting the App's installations (tracker-mirrors: Admins connect GitHub
// installations with the confirmation step; tracker-mirrors: Covered
// repositories follow each connected installation; activity-log: Which
// actions are security events; github-app-reachability: design.md, Design
// rules: Finding installations). The admin page lists every installation of
// the App that Tiehall found by listing them, connected or not. Tiehall
// ignores an installation until an admin connects it, in the web UI, with the
// confirmation step; the repositories it covers are read as soon as it is
// connected, with no delivery. Disconnecting needs no confirmation step, only
// the checks every web UI write passes, and removes no member. Connecting and
// disconnecting are security events.

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;
let github: InstallGitHub;
let ada: WebSessionCaller;
let mehmet: WebSessionCaller;
/** The number of the last event before the test: events are append-only, so each test reads only its own. */
let lastEvent: number;

beforeAll(async () => {
  install = await startTestInstall();
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addUser({ login: "lee" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addOrg({ login: "acme-labs", members: { omar: "admin", lee: "member" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme-labs/tools");
  stub.addRepo("acme-labs/docs");
  app = stub.createApp({ owner: "acme", public: true });
  ({ github } = await storeStubApp(install, stub, app));
  ada = { kind: "web_session", userId: await addUser(install.owner, { login: "ada", role: "admin" }), sessionId: randomUUID() };
  mehmet = { kind: "web_session", userId: await addUser(install.owner, { login: "mehmet", role: "member" }), sessionId: randomUUID() };
  install.sentJobs.length = 0;
  lastEvent = (await install.owner.query<{ last: number }>("SELECT coalesce(max(number), 0)::int AS last FROM events")).rows[0]?.last ?? 0;
});

afterEach(async () => {
  await stub.close();
  await install.owner.query(
    `DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations; DELETE FROM github_installations;
     DELETE FROM integration_secrets; DELETE FROM github_app; DELETE FROM receipts; DELETE FROM members; DELETE FROM sign_in_accounts; DELETE FROM users`,
  );
});

/** Lists the App's installations as a sync does; returns Tiehall's id of the one on this account. */
async function listed(account: string): Promise<string> {
  await readInstallations({ database: install.db, app: (await github.app())! });
  const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations WHERE account_login = $1", [account]);
  return rows[0]?.id ?? "";
}

/** Runs the jobs the install's writes sent, as the worker would. */
async function runSentJobs(): Promise<void> {
  for (const { queue, data } of install.sentJobs.splice(0)) {
    expect(queue).toBe(syncGitHubInstallations.type.queue);
    await syncGitHubInstallations.handle(
      { id: randomUUID(), queue, data: data as { repositoriesOf?: number[] }, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github, execute: install.execute },
    );
  }
}

const adminPage = (session: WebSessionCaller | undefined) =>
  createGitHubAdminRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

async function covered(): Promise<string[]> {
  const { rows } = await install.owner.query<{ full_name: string }>("SELECT full_name FROM github_covered_repositories ORDER BY 1");
  return rows.map(({ full_name }) => full_name);
}

async function connected(): Promise<string[]> {
  const { rows } = await install.owner.query<{ login: string }>(
    "SELECT i.account_login AS login FROM github_connected_installations c JOIN github_installations i ON i.org_id = c.org_id AND i.id = c.installation_id ORDER BY 1",
  );
  return rows.map(({ login }) => login);
}

async function securityEvents(): Promise<{ type: string; installation_id: string; actor_user_id: string }[]> {
  const { rows } = await install.owner.query<{ type: string; installation_id: string; actor_user_id: string }>(
    "SELECT type, data->>'installationId' AS installation_id, actor_user_id FROM events WHERE type LIKE 'github.%' AND number > $1 ORDER BY number",
    [lastEvent],
  );
  return rows;
}

describe("the admin page", () => {
  it("lists an installation nobody connected as not connected, offers to connect it, and Tiehall ignores it", async () => {
    await stub.install(app, { account: "acme-labs", repositories: ["acme-labs/tools"] }, { delivery: "none" });
    const labs = await listed("acme-labs");

    const page = await adminPage(ada)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Installations not connected");
    expect(html).toContain("acme-labs");
    expect(html).toContain(`/confirm/github.connect_installation?input=${encodeURIComponent(JSON.stringify({ installation: labs }))}`);
    expect(await connected()).toEqual([]);
    expect(await covered()).toEqual([]);
  });

  it("is an admin's: a member gets 403, and a browser without a session is sent to sign in", async () => {
    const refused = await adminPage(mehmet)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
    expect(refused.status).toBe(403);
    const anonymous = await adminPage(undefined)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(GITHUB_ADMIN_PATH)}`);
  });
});

describe("connecting an installation", () => {
  it("connects it once an admin confirms it: its repositories are read at once and count as covered, and a security event records it", async () => {
    await stub.install(app, { account: "acme-labs", repositories: ["acme-labs/tools", "acme-labs/docs"] }, { delivery: "none" });
    const labs = await listed("acme-labs");

    const confirmed = await install.confirm(ada, "github.connect_installation", { installation: labs });

    expect(confirmed.status).toBe(200);
    expect(await connected()).toEqual(["acme-labs"]);
    await runSentJobs();
    expect(await covered()).toEqual(["acme-labs/docs", "acme-labs/tools"]);
    expect(await securityEvents()).toEqual([{ type: "github.installation_connected", installation_id: labs, actor_user_id: ada.userId }]);
    const page = await (await adminPage(ada)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`))).text();
    expect(page).toContain("Connected installations");
    expect(page).toContain("acme-labs/tools");
  });

  it("shows on its review page what connecting does, and changes nothing there", async () => {
    await stub.install(app, { account: "acme-labs" }, { delivery: "none" });
    const labs = await listed("acme-labs");
    const page = await install.confirmRoute(ada)(
      new Request(`${URL_OF_INSTALL}/confirm/github.connect_installation?input=${encodeURIComponent(JSON.stringify({ installation: labs }))}`),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connect a GitHub installation");
    expect(html).toContain("acme-labs");
    expect(await connected()).toEqual([]);
  });

  it("refuses a connection without a valid confirmation with 403, and connects nothing", async () => {
    await stub.install(app, { account: "acme-labs" }, { delivery: "none" });
    const labs = await listed("acme-labs");
    const result = await install.web(ada).write("github.connect_installation", { installation: labs }, install.fromThePage(ada));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await connected()).toEqual([]);
    expect(await securityEvents()).toEqual([]);
  });

  it("refuses a member who is not an admin with 403, on the review page and on its confirmation, and connects nothing", async () => {
    await stub.install(app, { account: "acme-labs" }, { delivery: "none" });
    const labs = await listed("acme-labs");
    const answer = await install.confirm(mehmet, "github.connect_installation", { installation: labs });
    expect(answer.status).toBe(403);
    expect(await connected()).toEqual([]);
  });

  it("answers an installation Tiehall does not know with 404", async () => {
    const answer = await install.confirm(ada, "github.connect_installation", { installation: randomUUID() });
    expect(answer.status).toBe(404);
  });
});

describe("disconnecting an installation", () => {
  it("needs no confirmation step: it stops covering the repositories, keeps every member, and is a security event", async () => {
    await stub.install(app, { account: "acme-labs", repositories: ["acme-labs/tools"] }, { delivery: "none" });
    const labs = await listed("acme-labs");
    expect((await install.confirm(ada, "github.connect_installation", { installation: labs })).status).toBe(200);
    await runSentJobs();
    // Lee joined the install as a member of acme-labs.
    const lee = await addUser(install.owner, { login: "lee", role: "member" });
    const membersBefore = (await install.owner.query("SELECT user_id FROM members ORDER BY 1")).rows;

    const answer = await adminPage(ada)(
      new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ action: "disconnect", installation: labs, csrf: csrfTokenFor(install.authSecret, ada.sessionId) }).toString(),
      }),
    );

    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(GITHUB_ADMIN_PATH);
    expect(await connected()).toEqual([]);
    expect(await covered()).toEqual([]);
    expect((await install.owner.query("SELECT user_id FROM members ORDER BY 1")).rows).toEqual(membersBefore);
    expect(membersBefore).toContainEqual({ user_id: lee });
    expect((await securityEvents()).map(({ type }) => type)).toEqual(["github.installation_connected", "github.installation_disconnected"]);
    // It is listed again as not connected, for an admin to connect or leave.
    await expect((await adminPage(ada)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`))).text()).resolves.toContain(
      `/confirm/github.connect_installation?input=${encodeURIComponent(JSON.stringify({ installation: labs }))}`,
    );
  });

  it("refuses a disconnect from another origin, without the CSRF token, or by a member, with 403, and disconnects nothing", async () => {
    await stub.install(app, { account: "acme-labs" }, { delivery: "none" });
    const labs = await listed("acme-labs");
    expect((await install.confirm(ada, "github.connect_installation", { installation: labs })).status).toBe(200);
    const post = (session: WebSessionCaller, headers: Record<string, string>, csrf: string) =>
      adminPage(session)(
        new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ action: "disconnect", installation: labs, csrf }).toString(),
        }),
      );
    const sameOrigin = { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" };
    expect((await post(ada, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, csrfTokenFor(install.authSecret, ada.sessionId))).status).toBe(403);
    expect((await post(ada, sameOrigin, "")).status).toBe(403);
    expect((await post(mehmet, sameOrigin, csrfTokenFor(install.authSecret, mehmet.sessionId))).status).toBe(403);
    expect(await connected()).toEqual(["acme-labs"]);
  });
});
