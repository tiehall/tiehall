import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  ADMIN_PATH,
  checkGitHubDeliveryLog,
  createAdminRoute,
  connectInstallations,
  createGitHubAdminRoute,
  csrfTokenFor,
  GITHUB_ADMIN_PATH,
  pollGitHub,
  processDelivery,
  readInstallations,
  redeliverGitHubDeliveries,
  settleModeFromDeliveryLog,
  withOrg,
  WORKER_JOBS,
  type GitHubEvent,
  type WebSessionCaller,
} from "../src/index.ts";
import { databaseClock, serveWebhooks, storeStubApp, type StoredStubApp, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// GitHub's mode (tracker-mirrors: GitHub and Jira each run in webhook mode or
// polling mode; activity-log: Which actions are security events; design.md,
// Self-hosting decisions: S9; design.md, Readings to confirm: R6). An App
// created with a webhook starts in webhook mode. After the App's first
// installation, Tiehall reads the App's delivery log once: a failed delivery
// made after the App's credentials were stored puts GitHub in polling mode,
// and deliveries that succeed keep it in webhook mode. The admin page shows
// the mode, and an admin switches it in the web UI, with the checks every web
// UI write passes. Each change of the mode is a security event for a changed
// integration. The deliveries here are the GitHub stub's own, sent to a local
// server that answers with the real /webhooks/github route.

let install: TestInstall;
let stub: GitHubStub;
let hooks: WebhookServer;
let app: StubApp;
let stored: StoredStubApp;
let ada: WebSessionCaller;
let mehmet: WebSessionCaller;

beforeEach(async () => {
  install = await startTestInstall();
  // The stub logs deliveries by the database's clock, which stamps when the credentials were stored (databaseClock).
  stub = await startGitHubStub({ now: await databaseClock(install.owner) });
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  hooks = await serveWebhooks(install, () => stored.box);
  // The ping GitHub sends when the App is created fails: the setup screen has not stored the App yet.
  app = stub.createApp({ owner: "acme", hook: { url: hooks.url } });
  await stub.settled();
  stored = await storeStubApp(install, stub, app);
  // GitHub logs deliveries to the second; the ones from here on are logged after the credentials were stored.
  stub.advanceClock(2_000);
  ada = sessionOf(await addUser(install.owner, { login: "ada", role: "admin" }));
  mehmet = sessionOf(await addUser(install.owner, { login: "mehmet", role: "member" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await hooks?.close();
  await install?.close();
});

/** One run of the check of the delivery log, as the worker runs it every minute. */
async function check(github = stored.github): Promise<void> {
  await checkGitHubDeliveryLog.handle(
    { id: randomUUID(), queue: checkGitHubDeliveryLog.type.queue, data: {}, signal: new AbortController().signal },
    { database: install.db, now: () => new Date(), github, jobs: { send: async () => {} } },
  );
}

/** Lists the App's installations, as setup, the reconciliation or a delivery about an installation does. */
async function listInstallations(github = stored.github): Promise<void> {
  await readInstallations({ database: install.db, app: (await github.app())! });
}

async function mode(): Promise<string> {
  const { rows } = await install.owner.query<{ mode: string }>("SELECT mode FROM github_app");
  return rows[0]?.mode ?? "";
}

const adminPage = (session: WebSessionCaller) =>
  createGitHubAdminRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

async function pageText(session: WebSessionCaller = ada): Promise<string> {
  const page = await adminPage(session)(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
  expect(page.status).toBe(200);
  return page.text();
}

/** An admin page's form that switches the mode, as a browser posts it from the page. */
function switchTo(session: WebSessionCaller, target: string, headers: Record<string, string> = { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" }, csrf = csrfTokenFor(install.authSecret, session.sessionId)) {
  return adminPage(session)(
    new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ action: "set_mode", mode: target, csrf }).toString(),
    }),
  );
}

async function modeEvents(): Promise<{ actor_kind: string; actor_user_id: string | null; data: Record<string, string> }[]> {
  const { rows } = await install.owner.query<{ actor_kind: string; actor_user_id: string | null; data: Record<string, string> }>(
    "SELECT actor_kind, actor_user_id, data FROM events WHERE type = 'github.mode_changed' ORDER BY number",
  );
  return rows;
}

function readsOfTheLog(from = 0): number {
  return stub.received.slice(from).filter(({ path }) => path === "/app/hook/deliveries").length;
}

describe("the check of the App's delivery log", () => {
  it("runs every minute, as one of the worker's jobs", () => {
    expect(checkGitHubDeliveryLog.schedule).toBe("* * * * *");
    expect(WORKER_JOBS).toContain(checkGitHubDeliveryLog);
  });

  it("starts an App created with a webhook in webhook mode, which the admin page shows", async () => {
    expect(await mode()).toBe("webhook");
    expect(await pageText()).toContain("GitHub runs in webhook mode");
  });

  it("puts GitHub in polling mode on a failed delivery after the first installation, which the admin page shows and the activity log records", async () => {
    stub.setHookReachable(false);
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await stub.settled();
    await listInstallations();

    await check();

    expect(await mode()).toBe("polling");
    expect(await pageText()).toContain("GitHub runs in polling mode");
    expect(await modeEvents()).toEqual([
      { actor_kind: "system", actor_user_id: null, data: { mode: "polling", previousMode: "webhook", cause: "failed_delivery" } },
    ]);
  });

  it("keeps a reachable install in webhook mode, counting only deliveries made after the credentials were stored, and checks only once", async () => {
    // The failed ping was made before the credentials were stored; the installation's delivery succeeds.
    expect(stub.deliveries(app)[0]).toMatchObject({ event: "ping", statusCode: 401 });
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await stub.settled();
    expect(stub.deliveries(app).at(-1)).toMatchObject({ event: "installation", statusCode: 202 });
    await listInstallations();

    await check();
    expect(await mode()).toBe("webhook");

    // The check ran once: a delivery that fails later does not change the mode.
    const from = stub.received.length;
    stub.setHookReachable(false);
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    await check();
    expect(await mode()).toBe("webhook");
    expect(readsOfTheLog(from)).toBe(0);
    expect(await modeEvents()).toEqual([]);
  });

  it("waits for the first installation, and for a delivery made after the credentials were stored", async () => {
    await check();
    expect(readsOfTheLog()).toBe(0);

    await stub.install(app, { account: "acme", repositories: ["acme/web"] }, { delivery: "none" });
    await listInstallations();
    await check();
    expect(readsOfTheLog()).toBe(1);
    expect(await mode()).toBe("webhook");

    stub.setHookReachable(false);
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    await check();
    expect(await mode()).toBe("polling");
  });
});

describe("an admin's switch of the mode", () => {
  it("switches GitHub between the modes in the web UI, each switch a security event naming the admin", async () => {
    const answer = await switchTo(ada, "polling");
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(GITHUB_ADMIN_PATH);
    expect(await mode()).toBe("polling");
    expect(await pageText()).toContain("GitHub runs in polling mode");

    expect((await switchTo(ada, "webhook")).status).toBe(303);
    expect(await mode()).toBe("webhook");
    expect(await modeEvents()).toEqual([
      { actor_kind: "web_session", actor_user_id: ada.userId, data: { mode: "polling", previousMode: "webhook", cause: "admin_switch" } },
      { actor_kind: "web_session", actor_user_id: ada.userId, data: { mode: "webhook", previousMode: "polling", cause: "admin_switch" } },
    ]);
  });

  it("offers the switch to the other mode on the admin page", async () => {
    expect(await pageText()).toContain('name="mode" value="polling"');
    await switchTo(ada, "polling");
    expect(await pageText()).toContain('name="mode" value="webhook"');
  });

  it("stops the redelivery of failed deliveries once an admin switches to polling mode", async () => {
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await stub.settled();
    stub.setHookReachable(false);
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    await switchTo(ada, "polling");
    const from = stub.received.length;

    await redeliverGitHubDeliveries.handle(
      { id: randomUUID(), queue: redeliverGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github: stored.github },
    );

    expect(stub.received.slice(from).filter(({ path }) => path.startsWith("/app/hook"))).toEqual([]);
  });

  it("is not undone by the check: an admin's switch settles the mode", async () => {
    stub.setHookReachable(false);
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await stub.settled();
    await listInstallations();
    await switchTo(ada, "polling");
    await switchTo(ada, "webhook");

    await check();

    expect(await mode()).toBe("webhook");
  });

  it("refuses a member, another origin and a missing CSRF token with 403, and changes nothing", async () => {
    expect((await switchTo(mehmet, "polling")).status).toBe(403);
    expect((await switchTo(ada, "polling", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await switchTo(ada, "polling", undefined, "")).status).toBe(403);
    expect(await mode()).toBe("webhook");
    expect(await modeEvents()).toEqual([]);
  });
});

describe("the mode an App's credentials set (github-app-reachability 1.7)", () => {
  /** An App created without a webhook, as on a trial URL, stored in place of the one stored before. */
  async function storeAppWithoutWebhook(): Promise<StoredStubApp> {
    await install.owner.query("DELETE FROM github_covered_repositories; DELETE FROM github_connected_installations; DELETE FROM github_installations");
    const trial = stub.createApp({ owner: "acme", name: `Tiehall localhost ${stub.apps().length}` });
    return storeStubApp(install, stub, trial);
  }

  it("is set as the credentials are stored: polling without a webhook secret, webhook with one", async () => {
    await storeAppWithoutWebhook();
    expect(await mode()).toBe("polling");
    expect(await pageText()).toContain("GitHub runs in polling mode");

    // A new App with a webhook, as after `setup reopen`, moves GitHub to webhook mode, and one without back to polling mode.
    const withWebhook = stub.createApp({ owner: "acme", name: "Tiehall with a webhook", hook: { url: hooks.url } });
    await storeStubApp(install, stub, withWebhook);
    expect(await mode()).toBe("webhook");
    await storeAppWithoutWebhook();
    expect(await mode()).toBe("polling");
  });

  it("never asks GitHub for the delivery log of an App without a webhook", async () => {
    const trial = await storeAppWithoutWebhook();
    const app = stub.apps().at(-1)!;
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await listInstallations(trial.github);
    const from = stub.received.length;

    await check(trial.github);
    await redeliverGitHubDeliveries.handle(
      { id: randomUUID(), queue: redeliverGitHubDeliveries.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github: trial.github },
    );

    expect(stub.received.slice(from).filter(({ path }) => path.startsWith("/app/hook"))).toEqual([]);
    expect(await mode()).toBe("polling");
  });

  it("takes GitHub's 404 for the delivery log of an App without a webhook for no failed delivery: the mode stays polling and nothing shows a broken integration", async () => {
    const trial = await storeAppWithoutWebhook();
    const app = stub.apps().at(-1)!;
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await listInstallations(trial.github);
    const from = stub.received.length;

    // Forced: the log is read as the check reads it, although the App has no webhook.
    const settled = await settleModeFromDeliveryLog({ database: install.db, app: (await trial.github.app())! });

    expect(settled).toBeUndefined();
    expect(stub.received.slice(from).map(({ path, status }) => ({ path, status }))).toEqual([{ path: "/app/hook/deliveries", status: 404 }]);
    expect(await mode()).toBe("polling");
    expect(await modeEvents()).toEqual([]);
    const page = await pageText();
    expect(page).toContain("GitHub runs in polling mode");
    expect(page).not.toMatch(/fail|broken|not reach/i);
    // And no banner on the admin page (21.10).
    const admin = await createAdminRoute({ execute: install.execute, session: async () => ada, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger })(
      new Request(`${URL_OF_INSTALL}${ADMIN_PATH}`),
    );
    expect(admin.status).toBe(200);
    const adminText = await admin.text();
    expect(adminText).toContain("GitHub runs in polling mode");
    expect(adminText).not.toMatch(/fail|broken|not reach/i);
  });

  it("keeps the behavior of an App with a webhook: webhook mode, until a failed delivery after the first installation", async () => {
    expect(await mode()).toBe("webhook");
    stub.setHookReachable(false);
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await stub.settled();
    await listInstallations();
    await check();
    expect(await mode()).toBe("polling");
  });

  it("picks up a pull request change on an App without a webhook by polling, as a trial install does", async () => {
    const trial = await storeAppWithoutWebhook();
    const app = stub.apps().at(-1)!;
    await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    await listInstallations(trial.github);
    await withOrg(install.db, async (context) => {
      const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations");
      await connectInstallations(context, rows.map(({ id }) => id));
    });
    const poll = () =>
      pollGitHub.handle(
        { id: randomUUID(), queue: pollGitHub.type.queue, data: {}, signal: new AbortController().signal },
        { database: install.db, now: () => new Date(), github: trial.github, jobs: { send: async (_tx, queue, data) => void install.sentJobs.push({ queue, data }) } },
      );
    await poll();
    install.sentJobs.length = 0;
    await stub.openPullRequest("acme/web", { title: "Close FE-142", head: "fe-142", author: "omar" });

    await poll();

    const seen: number[] = [];
    for (const { data } of install.sentJobs.splice(0)) {
      await processDelivery(
        {
          database: install.db,
          github: trial.github,
          execute: install.execute,
          processors: { pull_request: async (event: GitHubEvent) => void seen.push((event.payload["pull_request"] as { number: number }).number) },
        },
        (data as { deliveryId: string }).deliveryId,
      );
    }
    expect(seen).toEqual([1]);
  });
});
