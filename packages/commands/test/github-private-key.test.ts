import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubApp } from "@tiehall/testing/github";
import {
  connectInstallations,
  createGitHubAdminRoute,
  createInstallGitHub,
  csrfTokenFor,
  GITHUB_ADMIN_PATH,
  readInstallations,
  readSecret,
  withOrg,
  type InstallGitHub,
  type WebSessionCaller,
} from "../src/index.ts";
import { storeStubApp } from "./support/github-app.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// A rotated App key can be uploaded (self-host-install: A rotated App key can
// be uploaded; agent-safety: Actions that need the confirmation step;
// activity-log: Which actions are security events; design.md, Self-hosting
// decisions: S4). After an admin generates a new private key in the App's
// settings on GitHub, they upload it in the web UI, with the confirmation step.
// Tiehall checks it before storing it, by requesting an installation token
// with it: a key GitHub accepts is stored encrypted, used for the next call to
// GitHub, and recorded as a security event; a key that fails the check is not
// stored, and the key in use stays. Like the webhook secret, the key is no
// part of the action's input, which the review page's URL carries: it is a
// file picked in a field of the review page's form, and travels only in the
// body of the POST that applies the action. While GitHub checks the key, the
// upload holds no lock on the App's stored row, so a slow answer holds up no
// other write of it, such as an admin's switch of GitHub's mode; the row is
// locked only to store the key, and a key checked for an App that another one
// replaced meanwhile is not stored.

let install: TestInstall;
let stub: GitHubStub;
let app: StubApp;
let github: InstallGitHub;
let ada: WebSessionCaller;
let mehmet: WebSessionCaller;
/** The key the setup screen stored, in use until an upload replaces it. */
let keyInUse: string;

const UPLOAD = "github.upload_private_key";

beforeEach(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addUser({ login: "omar" });
  stub.addOrg({ login: "acme", members: { omar: "admin" } });
  stub.addRepo("acme/web");
  app = stub.createApp({ owner: "acme" });
  keyInUse = app.pem;
  ({ github } = await storeStubApp(install, stub, app));
  install.useGitHub(github);
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
  await install?.close();
});

async function storedKey(): Promise<string | undefined> {
  return withOrg(install.db, (context) => readSecret(context, install.box, "github_app.private_key"));
}

async function keyEvents(): Promise<{ actor_kind: string; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query("SELECT actor_kind, actor_user_id FROM events WHERE type = 'github.private_key_uploaded' ORDER BY number");
  return rows;
}

/** A call to GitHub as the install's App, with the key it has stored now. */
async function callsGitHub(): Promise<boolean> {
  try {
    await readInstallations({ database: install.db, app: (await github.app())! });
    return true;
  } catch {
    return false;
  }
}

/** Uploads a key as an admin does: the review page, the key file picked in its form, and the confirmation. */
function upload(session: WebSessionCaller, pem: string): Promise<Response> {
  return install.confirm(session, UPLOAD, {}, {}, { privateKey: pem });
}

const reviewUrl = `/confirm/${UPLOAD}?input=${encodeURIComponent("{}")}`;

describe("uploading a rotated private key", () => {
  it("checks a valid key by requesting an installation token, stores it encrypted, uses it for the next call, and records a security event", async () => {
    const rotated = stub.addPrivateKey(app);
    const from = stub.received.length;

    const answer = await upload(ada, rotated);

    expect(answer.status).toBe(200);
    expect(stub.received.slice(from).map(({ method, path, status }) => `${method} ${path} ${status}`)).toContain(
      `POST /app/installations/${stub.installations(app)[0]!.id}/access_tokens 201`,
    );
    expect(await storedKey()).toBe(rotated);
    const { rows } = await install.owner.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM integration_secrets WHERE name = 'github_app.private_key'");
    expect(rows[0]?.ciphertext.toString("utf8")).not.toContain("PRIVATE KEY");
    expect(await keyEvents()).toEqual([{ actor_kind: "web_session", actor_user_id: ada.userId }]);

    // The old key is deleted on GitHub: the next call works, with the new key.
    stub.deletePrivateKey(app, keyInUse);
    expect(await callsGitHub()).toBe(true);
  });

  it("does not store a key that belongs to another GitHub App, and keeps calling GitHub with the key in use", async () => {
    const other = stub.createApp({ owner: "acme", name: "Another App" });

    const answer = await upload(ada, other.pem);

    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/invalid-input", errors: [{ path: ["privateKey"] }] });
    expect(await storedKey()).toBe(keyInUse);
    expect(await keyEvents()).toEqual([]);
    expect(await callsGitHub()).toBe(true);
  });

  it("refuses a file that is no private key, or an empty one, with 400, before asking GitHub, and stores nothing", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const file of ["", "not a key", publicKey.export({ type: "spki", format: "pem" }).toString()]) {
      const from = stub.received.length;
      const answer = await upload(ada, file);
      expect(answer.status, file).toBe(400);
      expect(stub.received.slice(from)).toEqual([]);
    }
    expect(await storedKey()).toBe(keyInUse);
    expect(await keyEvents()).toEqual([]);
  });

  it("refuses an upload without a confirmation, and one by a member who is not an admin, with 403, and the key in use is unchanged", async () => {
    const rotated = stub.addPrivateKey(app);
    const unconfirmed = await install.confirmRoute(ada)(
      new Request(`${URL_OF_INSTALL}/confirm/${UPLOAD}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ input: "{}", csrf: csrfTokenFor(install.authSecret, ada.sessionId), privateKey: rotated }).toString(),
      }),
    );
    expect(unconfirmed.status).toBe(403);
    expect(await unconfirmed.json()).toMatchObject({ type: "https://tiehall.com/problems/confirmation-required" });

    expect((await upload(mehmet, rotated)).status).toBe(403);

    expect(await storedKey()).toBe(keyInUse);
    expect(await keyEvents()).toEqual([]);
  });

  it("asks for the key file in a field of the review page's form, which posts it as a multipart form, and shows no key", async () => {
    const page = await install.confirmRoute(ada)(new Request(`${URL_OF_INSTALL}${reviewUrl}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/<form method="post" action="\/confirm\/github\.upload_private_key" enctype="multipart\/form-data">/);
    expect(html).toMatch(/<input type="file" id="[^"]+" name="privateKey" required>/);
    expect(html).toContain('<input type="hidden" name="input" value="{}">');
    expect(html).not.toContain("PRIVATE KEY");

    // The browser posts the picked file with the page's fields.
    const field = (name: string) =>
      (new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, code: string) =>
        String.fromCharCode(Number(code)),
      );
    const rotated = stub.addPrivateKey(app);
    const form = new FormData();
    form.set("input", field("input"));
    form.set("nonce", field("nonce"));
    form.set("csrf", field("csrf"));
    form.set("privateKey", new File([rotated], "tiehall.2026-09-29.private-key.pem", { type: "application/x-pem-file" }));
    const answer = await install.confirmRoute(ada)(
      new Request(`${URL_OF_INSTALL}/confirm/${UPLOAD}`, { method: "POST", headers: { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" }, body: form }),
    );

    expect(answer.status).toBe(200);
    expect(await storedKey()).toBe(rotated);
  });

  it("is offered on the admin page, through its review page", async () => {
    const page = await createGitHubAdminRoute({
      execute: install.execute,
      session: async () => ada,
      url: URL_OF_INSTALL,
      secret: () => install.authSecret,
      logger: install.logger,
    })(new Request(`${URL_OF_INSTALL}${GITHUB_ADMIN_PATH}`));
    expect(await page.text()).toContain(`href="${reviewUrl}"`);
  });
});

describe("an upload while GitHub checks the key slowly", () => {
  /**
   * Makes the install reach GitHub through a fetch that, once armed, holds the next token request open until it
   * is released; arm() resolves when that request is asked.
   */
  function heldTokens(): { arm: () => Promise<void>; release: () => void } {
    let armed = false;
    let asked: () => void = () => {};
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    install.useGitHub(
      createInstallGitHub({
        database: install.db,
        secrets: () => install.box,
        apiUrl: stub.apiUrl,
        logger: install.logger,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (armed && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
            armed = false;
            asked();
            await released;
          }
          return fetch(input, init);
        },
      }),
    );
    return {
      arm: () => {
        armed = true;
        return new Promise<void>((resolve) => (asked = resolve));
      },
      release,
    };
  }

  /**
   * Whether another transaction can lock the App's stored row at once, as a write of it, such as an admin's
   * switch of GitHub's mode, locks it: FOR UPDATE NOWAIT fails at once, rather than waiting, on a row another
   * transaction holds.
   */
  async function appRowIsFree(): Promise<boolean> {
    const other = new pg.Client({ connectionString: install.databaseUrl });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM github_app FOR UPDATE NOWAIT");
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "55P03") return false;
      throw error;
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await other.end();
    }
  }

  it("holds no lock on the App's row while GitHub answers, so another write of it can lock it at once", { timeout: 30_000 }, async () => {
    const held = heldTokens();
    const rotated = stub.addPrivateKey(app);
    const asked = held.arm();
    const uploading = upload(ada, rotated);
    await asked;

    let free: boolean;
    try {
      free = await appRowIsFree();
    } finally {
      held.release();
    }

    expect(free).toBe(true);
    expect((await uploading).status).toBe(200);
    expect(await storedKey()).toBe(rotated);
  });

  it("does not store a key checked for an App that another replaced meanwhile, with 409", { timeout: 30_000 }, async () => {
    const held = heldTokens();
    const rotated = stub.addPrivateKey(app);
    const asked = held.arm();
    const uploading = upload(ada, rotated);
    await asked;
    try {
      // A new App's credentials are stored while GitHub checks the key, as a step that setup reopen opened stores them.
      await install.owner.query("UPDATE github_app SET app_id = app_id + 1, client_id = 'Iv23liAnotherApp'");
    } finally {
      held.release();
    }
    const answer = await uploading;

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ type: "https://tiehall.com/problems/conflict" });
    expect(await storedKey()).toBe(keyInUse);
    expect(await keyEvents()).toEqual([]);
  });
});
