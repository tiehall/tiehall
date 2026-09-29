import { randomBytes } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signBody, startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { startAppServer, type AppServer } from "./support/app-server.ts";

// Moving an App without a webhook to webhook mode in a real browser
// (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode;
// agent-safety: Actions that need the confirmation step; github-app-
// reachability: design.md, Design rules: Moving to webhook mode). The operator
// sets up the install at https://tiehall.example.com with "GitHub cannot
// reach this address", so the App has no webhook and GitHub runs in polling
// mode. The admin page then shows the steps to webhook mode; the operator,
// now its first admin, follows the link to the review page, types the secret
// into its password field, confirms, and switches GitHub to webhook mode. The
// secret travels only in the body of the POST that applies the action: no URL
// the browser requested and no page it rendered, the review page included,
// carries it.

let stub: GitHubStub;
let server: AppServer;
let browser: Browser;

// The hooks start and close an install and Chrome for each test, so they get timeouts that hold on a CI runner, not
// Vitest's 10-second default for hooks.
beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  stub.signIn("omar");
  server = await startAppServer(stub);
  const executablePath = process.env["TIEHALL_TEST_CHROME"];
  browser = await chromium.launch({ ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }), args: server.browserArgs });
}, 120_000);

afterEach(async () => {
  await browser?.close();
  await server?.close();
  await stub?.close();
}, 60_000);

/** Setup with "GitHub cannot reach this address": the App is created without a webhook, installed on acme, and the operator signs in. */
async function setUpWithoutWebhook(page: Page): Promise<void> {
  const { url } = server;
  const code = await server.start();
  await page.goto(`${url}/setup`);
  await page.getByLabel("Setup code").fill(code);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Continue" }).click()]);
  await page.getByLabel("The company's name").fill("Acme");
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Save the name" }).click()]);
  await page.getByLabel("The GitHub organization that owns the App").fill("acme");
  await page.getByLabel("GitHub cannot reach this address").check();
  await Promise.all([page.waitForURL(/unreachable=1/), page.getByRole("button", { name: "Apply" }).click()]);
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/apps/new?*`), page.getByRole("button", { name: "Create the GitHub App" }).click()]);
  await Promise.all([page.waitForURL(`${url}/setup`), page.getByRole("button", { name: "Create GitHub App for acme" }).click()]);
  const [app] = stub.apps();
  await Promise.all([page.waitForURL(`${stub.webUrl}/apps/${app?.slug}/installations/new`), page.getByRole("link", { name: `Install ${app?.name} on GitHub` }).click()]);
  await page.getByLabel("Only select repositories").check();
  await page.getByLabel("acme/web").check();
  await Promise.all([page.waitForURL(`${stub.webUrl}/organizations/acme/settings/installations/*`), page.getByRole("button", { name: "Install" }).click()]);
  await page.goto(`${url}/setup`);
  await Promise.all([page.waitForURL(`${stub.webUrl}/login/oauth/authorize?*`), page.getByRole("button", { name: "Sign in with GitHub" }).click()]);
  await Promise.all([page.waitForURL(`${url}/`), page.getByRole("button", { name: `Authorize ${app?.name}` }).click()]);
}

describe("moving to webhook mode", { timeout: 120_000 }, () => {
  it("stores the secret through the review page's password field, switches to webhook mode, and no URL or page carries the secret", async () => {
    const secret = `whsec-${randomBytes(24).toString("hex")}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const rendered: string[] = [];
    const snapshot = async () => void rendered.push(await page.content());

    await setUpWithoutWebhook(page);
    expect((await server.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "polling" }]);

    // The admin page shows polling mode and the steps, and offers no switch to webhook mode yet.
    await page.goto(`${server.url}/admin/github`);
    await snapshot();
    await expect(page.getByText("GitHub runs in polling mode").count()).resolves.toBe(1);
    await expect(page.getByText("https://tiehall.example.com/webhooks/github").count()).resolves.toBe(1);
    await expect(page.getByRole("button", { name: "Switch to webhook mode" }).count()).resolves.toBe(0);

    // The review page names the action; the secret is typed into its password field and sent with the confirmation.
    await Promise.all([page.waitForURL(/\/confirm\/github\.store_webhook_secret\?/), page.getByRole("link", { name: "Store the same secret in Tiehall" }).click()]);
    await snapshot();
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Store the GitHub App's webhook secret");
    const field = page.getByLabel("The webhook secret, as set in the App's settings on GitHub");
    await expect(field.getAttribute("type")).resolves.toBe("password");
    await field.fill(secret);
    const [posted] = await Promise.all([
      page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/confirm/github.store_webhook_secret")),
      page.getByRole("button", { name: "Confirm" }).click(),
    ]);
    await page.waitForLoadState();
    await snapshot();
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe("Confirmed");
    // The secret went in the POST's body, and nowhere else.
    expect(posted.postData()).toContain(`secret=${secret}`);
    expect(new URL(posted.url()).search).toBe("");

    // The switch to webhook mode is offered now.
    await page.goto(`${server.url}/admin/github`);
    await Promise.all([page.waitForURL(`${server.url}/admin/github`), page.getByRole("button", { name: "Switch to webhook mode" }).click()]);
    await snapshot();
    await expect(page.getByText("GitHub runs in webhook mode").count()).resolves.toBe(1);
    expect((await server.owner.query("SELECT mode FROM github_app")).rows).toEqual([{ mode: "webhook" }]);

    // Deliveries are verified with the stored secret: one signed with it is accepted, one signed with another is refused.
    const deliver = (signedWith: string) => {
      const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
      return server.handle(
        new Request(`${server.url}/webhooks/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256": signBody(signedWith, body).sha256,
          },
          body,
        }),
      );
    };
    expect((await deliver(secret)).status).toBe(202);
    expect((await deliver("another-secret")).status).toBe(401);

    for (const url of requested) expect(url).not.toContain(secret);
    for (const html of rendered) expect(html).not.toContain(secret);
    expect(rendered).toHaveLength(4);
    await context.close();
  });
});
