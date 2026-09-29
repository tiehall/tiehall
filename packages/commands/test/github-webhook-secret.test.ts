import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signBody, startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  createGitHubAdminRoute,
  csrfTokenFor,
  GITHUB_ADMIN_PATH,
  processDelivery,
  readInstallations,
  readSecret,
  withOrg,
  connectInstallations,
  type GitHubEvent,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { serveWebhooks, storeStubApp, type WebhookServer } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// Moving an App without a webhook to webhook mode (tracker-mirrors: GitHub and
// Jira each run in webhook mode or polling mode; agent-safety: Actions that
// need the confirmation step; activity-log: Which actions are security events;
// github-app-reachability: design.md, Design rules: Moving to webhook mode).
// While no webhook secret is stored and TIEHALL_URL is not a trial URL, the
// admin page shows GitHub's polling mode and the steps to webhook mode: the
// webhook and the three events in the App's settings on GitHub, the same
// secret stored in Tiehall, then the switch. On a trial URL it says that
// GitHub cannot deliver webhooks there. An admin stores the secret with the
// confirmation step: the review page names the action without the secret, the
// admin types the secret into a password field of its form, and the secret
// travels only in the body of the POST that applies the action. The switch to
// webhook mode is refused with 409 while no secret is stored.

let install: TestInstall;
let stub: GitHubStub;
let hooks: WebhookServer;
let app: StubApp;
let github: InstallGitHub;
let ada: WebSessionCaller;
let mehmet: WebSessionCaller;

const SECRET_COMMAND = "github.store_webhook_secret";

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  hooks = await serveWebhooks(install, () => install.box);
  // The operator chose "GitHub cannot reach this address": the App has no webhook, and GitHub runs in polling mode.
  app = stub.createApp({ owner: "acme", name: "Tiehall tiehall.example.com" });
  ({ github } = await storeStubApp(install, stub, app));
  await stub.install(app, { account: "acme", repositories: ["acme/web"] });
  await readInstallations({ database: install.db, app: (await github.app())! });
  await withOrg(install.db, async (context) => {
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM github_installations");
    await connectInstallations(context, rows.map(({ id }) => id));
  });
  ada = sessionOf(await addUser(install.owner, { login: "ada", role: "admin" }));
  mehmet = sessionOf(await addUser(install.owner, { login: "mehmet", role: "member" }));
}, 60_000);

afterEach(async () => {
  await stub?.close();
  await hooks?.close();
  await install?.close();
});

const adminPage = (session: WebSessionCaller, url = URL_OF_INSTALL) =>
  createGitHubAdminRoute({ execute: install.execute, session: async () => session, url, secret: () => install.authSecret, logger: install.logger });

async function pageText(session: WebSessionCaller = ada, url = URL_OF_INSTALL): Promise<string> {
  const page = await adminPage(session, url)(new Request(`${url}${GITHUB_ADMIN_PATH}`));
  expect(page.status).toBe(200);
  return page.text();
}

function switchTo(session: WebSessionCaller, target: string) {
  return adminPage(session)(
    new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ action: "set_mode", mode: target, csrf: csrfTokenFor(install.authSecret, session.sessionId) }).toString(),
    }),
  );
}

async function storedSecret(): Promise<string | undefined> {
  return withOrg(install.db, (context) => readSecret(context, install.box, "github_app.webhook_secret"));
}

async function mode(): Promise<string> {
  const { rows } = await install.owner.query<{ mode: string }>("SELECT mode FROM github_app");
  return rows[0]?.mode ?? "";
}

async function secretEvents(): Promise<{ actor_kind: string; actor_user_id: string | null; data: Record<string, unknown> }[]> {
  const { rows } = await install.owner.query("SELECT actor_kind, actor_user_id, data FROM events WHERE type = 'github.webhook_secret_stored' ORDER BY number");
  return rows;
}

/** Stores a secret as an admin does: the review page, the secret typed into its form, and the confirmation. */
function storeSecret(session: WebSessionCaller, secret: string): Promise<Response> {
  return install.confirm(session, SECRET_COMMAND, {}, {}, { secret });
}

const reviewUrl = `/confirm/${SECRET_COMMAND}?input=${encodeURIComponent("{}")}`;

describe("the admin page of an App without a webhook", () => {
  it("shows polling mode and the steps to webhook mode, with the install's own webhook URL, the three events and the App's settings on GitHub", async () => {
    const html = await pageText();

    expect(html).toContain("GitHub runs in polling mode");
    expect(html).toContain("https://tiehall.example.com/webhooks/github");
    for (const event of ["pull_request", "issues", "organization"]) expect(html).toContain(event);
    expect(html).toContain(`href="https://github.com/organizations/acme/settings/apps/${app.slug}"`);
    expect(html).toContain(`href="${reviewUrl.replaceAll("&", "&amp;")}"`);
    // No switch to webhook mode is offered while no secret is stored.
    expect(html).not.toContain('name="mode" value="webhook"');
  });

  it("links to the settings of an App a personal account owns", async () => {
    stub.addUser({ login: "omar-solo" });
    const personal = stub.createApp({ owner: "omar-solo", name: "Tiehall solo" });
    await storeStubApp(install, stub, personal);
    expect(await pageText()).toContain(`href="https://github.com/settings/apps/${personal.slug}"`);
  });

  it("says on a trial URL that GitHub cannot deliver webhooks to it, and shows no steps", async () => {
    const trial = "http://localhost:3000";
    const html = await pageText(ada, trial);

    expect(html).toContain("GitHub runs in polling mode");
    expect(html).toContain("GitHub cannot deliver webhooks to http://localhost:3000");
    expect(html).not.toContain("/webhooks/github");
    expect(html).not.toContain(SECRET_COMMAND);
    expect(html).not.toContain('name="mode" value="webhook"');
  });
});

describe("storing the webhook secret", () => {
  it("names the action on its review page without any secret, and asks for the secret in a password field of its form", async () => {
    const page = await install.confirmRoute(ada)(new Request(`${URL_OF_INSTALL}${reviewUrl}`));

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/Store the GitHub App(?:'|&#39;)s webhook secret/);
    expect(html).toMatch(/<input type="password" id="[^"]+" name="secret" autocomplete="off" required>/);
    expect(html).toContain('<input type="hidden" name="input" value="{}">');
    expect(await storedSecret()).toBeUndefined();
  });

  it("stores the secret encrypted once an admin confirms it, replacing any stored one, and records a security event for the changed integration", async () => {
    const secret = randomBytes(24).toString("hex");
    const answer = await storeSecret(ada, secret);

    expect(answer.status).toBe(200);
    expect(await storedSecret()).toBe(secret);
    const { rows } = await install.owner.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM integration_secrets WHERE name = 'github_app.webhook_secret'");
    expect(rows[0]?.ciphertext.toString("utf8")).not.toContain(secret);
    expect(await secretEvents()).toEqual([{ actor_kind: "web_session", actor_user_id: ada.userId, data: { replaced: false } }]);
    expect(await mode()).toBe("polling");

    const another = randomBytes(24).toString("hex");
    expect((await storeSecret(ada, another)).status).toBe(200);
    expect(await storedSecret()).toBe(another);
    expect((await secretEvents()).map(({ data }) => data)).toEqual([{ replaced: false }, { replaced: true }]);
  });

  it("refuses an empty secret with 400, and stores nothing", async () => {
    const answer = await storeSecret(ada, "");
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", errors: [{ path: ["secret"] }] });
    expect(await storedSecret()).toBeUndefined();
    expect(await secretEvents()).toEqual([]);
  });

  it("refuses a member who is not an admin with 403, and stores nothing", async () => {
    const answer = await storeSecret(mehmet, "a-secret-of-mehmet");
    expect(answer.status).toBe(403);
    expect(await storedSecret()).toBeUndefined();
  });

  it("refuses a request without a confirmation with 403, and stores nothing", async () => {
    const answer = await install.confirmRoute(ada)(
      new Request(`${URL_OF_INSTALL}/confirm/${SECRET_COMMAND}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ input: "{}", csrf: csrfTokenFor(install.authSecret, ada.sessionId), secret: "a-secret" }).toString(),
      }),
    );
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/confirmation-required" });
    expect(await storedSecret()).toBeUndefined();
  });
});

describe("the switch to webhook mode", () => {
  it("is refused with 409 while no webhook secret is stored, and GitHub stays in polling mode", async () => {
    const answer = await switchTo(ada, "webhook");
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/conflict" });
    expect(await mode()).toBe("polling");
  });

  it("moves the App to webhook mode once the secret is stored: a delivery signed with it is stored and processed, one signed with another gets 401", async () => {
    const secret = randomBytes(24).toString("hex");
    // The admin adds the webhook and the three events in the App's settings on GitHub.
    stub.updateApp(app, { hook: { url: hooks.url }, webhookSecret: secret, events: ["pull_request", "issues", "organization"] });
    expect((await storeSecret(ada, secret)).status).toBe(200);
    expect(await pageText()).toContain('name="mode" value="webhook"');

    expect((await switchTo(ada, "webhook")).status).toBe(303);
    expect(await mode()).toBe("webhook");
    expect(await pageText()).toContain("GitHub runs in webhook mode");

    install.sentJobs.length = 0;
    await stub.openPullRequest("acme/web", { title: "Fix the header", head: "fix-header", author: "omar" });
    await stub.settled();
    const delivered = stub.deliveries(app).at(-1)!;
    expect(delivered.statusCode).toBe(202);
    expect(install.sentJobs.map(({ queue }) => queue)).toEqual(["github.process_delivery.v1"]);
    const seen: string[] = [];
    await processDelivery(
      { database: install.db, github, execute: install.execute, processors: { pull_request: async (event: GitHubEvent) => void seen.push(event.deliveryId) } },
      delivered.guid,
    );
    expect(seen).toEqual([delivered.guid]);
    const { rows } = await install.owner.query("SELECT processed_at IS NOT NULL AS processed FROM github_deliveries WHERE delivery_id = $1", [delivered.guid]);
    expect(rows).toEqual([{ processed: true }]);

    const body = JSON.stringify({ action: "opened", installation: { id: 1 } });
    const forged = await fetch(hooks.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "0b989ba4-242f-11e5-81e1-c7b6966d2516",
        "x-hub-signature-256": signBody("another-secret", body).sha256,
      },
      body,
    });
    expect(forged.status).toBe(401);
  });
});
