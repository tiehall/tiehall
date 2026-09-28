import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signAppJwt, startGitHubStub, type GitHubStub } from "../src/github/index.ts";

// The GitHub stub's contract (design.md, Technical decisions: T17; design.md
// of github-app-reachability, Technical decisions: T4). Every later GitHub
// test runs against the stub, so the stub must answer as GitHub did when the
// spikes of tasks 1.5 and 1.6 ran against it on 2026-09-28. These tests
// replay the committed records of that run (fixtures/github-app-spike) and
// derive what they expect from them, so a record and the stub cannot drift
// apart unnoticed.

interface LogEntry {
  id: number;
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

interface Check {
  task: string;
  id: string;
  state: string;
  evidence: string[];
}

interface ManifestAnswer {
  variant: number;
  manifest: Record<string, unknown>;
  accepted: boolean;
  messages: string[];
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/github-app-spike/${name}`, import.meta.url), "utf8")) as T;
}

const log = fixture<LogEntry[]>("log-2026-09-28.json");
const status = fixture<{ checks: Check[]; credentials: Record<string, unknown> }>("status-2026-09-28.json");
const answers = fixture<{
  manifests: { refusalTitle: string; answers: ManifestAnswer[] };
  tokenExchange: { wrongClientSecret: { error: string; error_description: string } };
}>("answers-2026-09-28.json");

const entries = (kind: string): LogEntry[] => log.filter((entry) => entry.kind === kind);
const check = (id: string): Check => {
  const found = status.checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no check ${id} in the status record`);
  return found;
};

/** "emails:read, issues:write" as a permissions object. */
function permissionsOf(list: string): Record<string, string> {
  return Object.fromEntries(list.split(", ").map((pair) => pair.split(":") as [string, string]));
}

// What the records say.
const stored = entries("credentials_stored")[0]!.detail as {
  ownerLogin: string;
  webhookSecretLength: number | null;
};
const conversions = entries("conversion_response").map((entry) => entry.detail as { status: number; elapsedMs: number; fieldNames: string[] });
const tokenUses = entries("installation_token_used").map(
  (entry) =>
    ({ at: entry.at, ...entry.detail }) as {
      at: string;
      expiresAt: string;
      permissions: Record<string, string>;
      reposStatus: number;
      tokenStatus: number;
      tokenLength: number;
      repositories: string[];
    },
);
const seenAtSignIn = [...entries("account_create_before"), ...entries("account_update_before")].map(
  (entry) => (entry.detail as { seen: Record<string, string> }).seen,
);
const appPermissions = permissionsOf(
  check("app-permissions").evidence.find((line) => line.startsWith("GET /app permissions: "))!.slice("GET /app permissions: ".length),
);
const appEvents = check("app-permissions").evidence.find((line) => line.startsWith("GET /app events: "))!.slice("GET /app events: ".length);
const deliveryLogAnswer = /^GET \/app\/hook\/deliveries failed: (\d{3}) (.*)$/.exec(check("deliveries-after-install").evidence[0]!)!;
const accountId = Number(/= GitHub account id (\d+),/.exec(check("sign-in").evidence[0]!)![1]);
const [repositoryOwner, repositoryName] = tokenUses[0]!.repositories[0]!.split("/") as [string, string];

/** The spike's App: the manifest GitHub accepted. */
const acceptedManifest = answers.manifests.answers.find((answer) => answer.accepted)!.manifest;
const callbackUrl = (acceptedManifest["callback_urls"] as string[])[0]!;

let stub: GitHubStub;

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: stored.ownerLogin, id: accountId, name: "Example User", email: "example-user@example.com" });
  stub.addRepo(`${repositoryOwner}/${repositoryName}`, { private: true });
  stub.signIn(stored.ownerLogin);
});

afterEach(async () => {
  await stub.close();
});

/** Posts a manifest to the personal new-App page, as the setup screen's form does. */
async function postManifest(manifest: Record<string, unknown>, state = "state-1"): Promise<Response> {
  return fetch(`${stub.webUrl}/settings/apps/new?state=${state}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ manifest: JSON.stringify(manifest) }),
    redirect: "manual",
  });
}

/** The hidden fields and the action of the first form of a page. */
function formOf(html: string): { action: string; fields: Record<string, string> } {
  const action = /<form[^>]*action="([^"]*)"/.exec(html)?.[1];
  if (action === undefined) throw new Error("the page has no form");
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g)) {
    fields[name!] = value!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  }
  return { action, fields };
}

/** Confirms a manifest on GitHub's confirmation page, and returns where GitHub sends the browser. */
async function confirm(page: string): Promise<URL> {
  const { action, fields } = formOf(page);
  const response = await fetch(new URL(action, stub.webUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

/** Creates the spike's App through the new-App page and returns the code GitHub redirected back with. */
async function createSpikeApp(): Promise<string> {
  const accepted = await postManifest(acceptedManifest, "state-2");
  expect(accepted.status).toBe(200);
  const back = await confirm(await accepted.text());
  expect(back.origin + back.pathname).toBe(acceptedManifest["redirect_url"]);
  expect(back.searchParams.get("state")).toBe("state-2");
  return back.searchParams.get("code")!;
}

async function convert(code: string): Promise<Response> {
  return fetch(`${stub.apiUrl}/app-manifests/${code}/conversions`, { method: "POST" });
}

describe("the manifest answers GitHub gave (spike 1.6)", () => {
  for (const answer of answers.manifests.answers) {
    it(`answers variant ${answer.variant} as GitHub did: ${answer.accepted ? "accepted" : "refused"}`, async () => {
      const response = await postManifest(answer.manifest);
      const page = await response.text();
      // A refusal is a page with no way back: never a redirect to the install.
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      if (answer.accepted) {
        expect(page).not.toContain(answers.manifests.refusalTitle);
        expect(formOf(page).action).toBeTruthy();
      } else {
        expect(page).toContain(answers.manifests.refusalTitle);
        const shown = [...page.matchAll(/<li class="error">([^<]*)<\/li>/g)].map(([, text]) => text!.replaceAll("&#39;", "'"));
        expect(shown).toEqual(answer.messages);
      }
      // Posting a manifest creates no App; only the confirmation does.
      expect(stub.apps()).toHaveLength(0);
    });
  }

  it("creates the App only when the accepted manifest is confirmed, and sends the browser back with a code", async () => {
    const code = await createSpikeApp();
    expect(code).toMatch(/^[0-9a-f]{20}$/);
    expect(stub.apps()).toHaveLength(1);
  });
});

describe("the code conversion (spike 1.6)", () => {
  it("answers with the recorded status and exactly the recorded fields", async () => {
    const code = await createSpikeApp();
    const response = await convert(code);
    for (const recorded of conversions) {
      expect(response.status).toBe(recorded.status);
    }
    const body = (await response.json()) as Record<string, unknown>;
    for (const recorded of conversions) {
      expect(Object.keys(body).sort()).toEqual(recorded.fieldNames);
    }
  });

  it("gives no webhook secret to an App without a webhook, and names the App's owner with its login and type", async () => {
    expect(stored.webhookSecretLength).toBeNull();
    const body = (await (await convert(await createSpikeApp())).json()) as {
      webhook_secret: unknown;
      owner: { login: string; type: string };
      pem: string;
      permissions: Record<string, string>;
      events: string[];
    };
    expect(body.webhook_secret).toBeNull();
    expect(body.owner).toMatchObject({ login: stored.ownerLogin, type: "User" });
    expect(body.pem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(body.permissions).toEqual(acceptedManifest["default_permissions"]);
    expect(body.events).toEqual([]);
  });

  it("takes each code once, within the hour", async () => {
    const recordedWithinTheHour = conversions.every((recorded) => recorded.elapsedMs < 3_600_000);
    expect(recordedWithinTheHour).toBe(true);
    const code = await createSpikeApp();
    expect((await convert(code)).status).toBe(201);
    expect((await convert(code)).status).toBe(404);

    const late = await createSpikeAppAfterRename("Tiehall example localhost 2");
    stub.advanceClock(3_600_000 + 1_000);
    expect((await convert(late)).status).toBe(404);
  });
});

async function createSpikeAppAfterRename(name: string): Promise<string> {
  const response = await postManifest({ ...acceptedManifest, name }, "state-3");
  return new URL((await confirm(await response.text())).href).searchParams.get("code")!;
}

describe("the App's own credentials (spike 1.6)", () => {
  async function createdApp(): Promise<{ clientId: string; appId: number; pem: string }> {
    const body = (await (await convert(await createSpikeApp())).json()) as { client_id: string; id: number; pem: string };
    return { clientId: body.client_id, appId: body.id, pem: body.pem };
  }

  it("reports the permissions GitHub kept and no events, to an App JWT whose issuer is the client id", async () => {
    const { clientId, pem } = await createdApp();
    const jwt = signAppJwt({ privateKey: pem, issuer: clientId });
    const response = await fetch(`${stub.apiUrl}/app`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(response.status).toBe(200);
    const app = (await response.json()) as { permissions: Record<string, string>; events: string[] };
    expect(app.permissions).toEqual(appPermissions);
    expect(appEvents).toBe("(none)");
    expect(app.events).toEqual([]);
  });

  it("has no delivery log for an App without a webhook", async () => {
    const { clientId, pem } = await createdApp();
    const jwt = signAppJwt({ privateKey: pem, issuer: clientId });
    const response = await fetch(`${stub.apiUrl}/app/hook/deliveries?per_page=100`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(response.status).toBe(Number(deliveryLogAnswer[1]));
    expect(await response.json()).toEqual(JSON.parse(deliveryLogAnswer[2]!));
  });

  it("lists the installation made after creation, found without any delivery, and lists its repositories to an installation token", async () => {
    const { clientId, pem } = await createdApp();
    const app = stub.apps()[0]!;
    await stub.install(app, { account: stored.ownerLogin, repositories: [tokenUses[0]!.repositories[0]!] });
    const jwt = signAppJwt({ privateKey: pem, issuer: clientId });

    const listed = await fetch(`${stub.apiUrl}/app/installations?per_page=100`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(listed.status).toBe(200);
    const installations = (await listed.json()) as Array<{
      id: number;
      account: { login: string; type: string };
      repository_selection: string;
      permissions: Record<string, string>;
      events: string[];
    }>;
    expect(installations).toHaveLength(1);
    const [installation] = installations;
    expect(installation!.account).toMatchObject({ login: stored.ownerLogin, type: "User" });
    expect(installation!.repository_selection).toBe("selected");
    expect(installation!.events).toEqual([]);

    for (const recorded of tokenUses) {
      const created = Date.now();
      const tokenResponse = await fetch(`${stub.apiUrl}/app/installations/${installation!.id}/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(tokenResponse.status).toBe(recorded.tokenStatus);
      const token = (await tokenResponse.json()) as { token: string; expires_at: string; permissions: Record<string, string> };
      expect(token.permissions).toEqual(recorded.permissions);
      expect(installation!.permissions).toEqual(recorded.permissions);
      // GitHub gave each token an hour, with its expiry to the second: the spike logged the token's use
      // a moment after GitHub answered.
      const recordedLifetime = Date.parse(recorded.expiresAt) - Date.parse(recorded.at);
      expect(recordedLifetime).toBeGreaterThan(3_598_000);
      expect(recordedLifetime).toBeLessThanOrEqual(3_600_000);
      const lifetime = Date.parse(token.expires_at) - created;
      expect(lifetime).toBeGreaterThan(3_598_000);
      expect(lifetime).toBeLessThanOrEqual(3_601_000);
      expect(token.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

      const repositories = await fetch(`${stub.apiUrl}/installation/repositories?per_page=100`, {
        headers: { authorization: `token ${token.token}` },
      });
      expect(repositories.status).toBe(recorded.reposStatus);
      const listedRepositories = (await repositories.json()) as { repositories: Array<{ full_name: string }> };
      expect(listedRepositories.repositories.map((repository) => repository.full_name)).toEqual(recorded.repositories);
    }
  });

  it("issues installation tokens of the recorded length when asked, and of 520 characters by default", async () => {
    const { clientId, pem } = await createdApp();
    const installation = await stub.install(stub.apps()[0]!, { account: stored.ownerLogin, repositories: "all" });
    const jwt = signAppJwt({ privateKey: pem, issuer: clientId });
    const token = async (): Promise<string> => {
      const response = await fetch(`${stub.apiUrl}/app/installations/${installation.id}/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });
      return ((await response.json()) as { token: string }).token;
    };
    // GitHub announced a format of about 520 characters; the spike still saw the old length.
    expect((await token()).length).toBe(520);
    stub.setInstallationTokenLength(tokenUses[0]!.tokenLength);
    expect((await token()).length).toBe(tokenUses[0]!.tokenLength);
  });
});

describe("user authorization (spike 1.5)", () => {
  async function createdApp(): Promise<{ clientId: string; clientSecret: string }> {
    const body = (await (await convert(await createSpikeApp())).json()) as { client_id: string; client_secret: string };
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }

  /** Walks GitHub's authorize page as the signed-in user and returns the code it redirects back with. */
  async function authorize(clientId: string, state: string): Promise<string> {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, state, scope: "read:user user:email" });
    let response = await fetch(`${stub.webUrl}/login/oauth/authorize?${query}`, { redirect: "manual" });
    if (response.status === 200) {
      const { action, fields } = formOf(await response.text());
      response = await fetch(new URL(action, stub.webUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, authorize: "1" }),
        redirect: "manual",
      });
    }
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(callbackUrl);
    expect(back.searchParams.get("state")).toBe(state);
    return back.searchParams.get("code")!;
  }

  async function exchange(clientId: string, clientSecret: string, code: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${stub.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  /** The shape the spike's account hook saw, such as "string(40)", "date(24)" or "absent". */
  function shapeOf(value: unknown): string {
    if (value === undefined || value === null) return "absent";
    if (typeof value === "string") return `string(${value.length})`;
    return typeof value;
  }

  it("issues expiring user tokens of the recorded shapes, at the first sign-in and at a repeat one", async () => {
    const { clientId, clientSecret } = await createdApp();
    expect(seenAtSignIn).toHaveLength(2);
    for (const [index, seen] of seenAtSignIn.entries()) {
      const tokens = await exchange(clientId, clientSecret, await authorize(clientId, `sign-in-${index}`));
      expect(shapeOf(tokens["access_token"])).toBe(seen["accessToken"]);
      expect(shapeOf(tokens["refresh_token"])).toBe(seen["refreshToken"]);
      expect(shapeOf(tokens["id_token"])).toBe(seen["idToken"]);
      // The hook saw both expiries as dates: the answer gives each as seconds from now.
      expect(seen["accessTokenExpiresAt"]).toMatch(/^date/);
      expect(seen["refreshTokenExpiresAt"]).toMatch(/^date/);
      expect(tokens["expires_in"]).toBe(28_800);
      expect(tokens["refresh_token_expires_in"]).toBe(15_897_600);
      expect(tokens["token_type"]).toBe("bearer");
    }
  });

  it("tells the sign-in who signed in and their primary verified email", async () => {
    const { clientId, clientSecret } = await createdApp();
    const tokens = await exchange(clientId, clientSecret, await authorize(clientId, "sign-in"));
    const headers = { authorization: `Bearer ${String(tokens["access_token"])}` };
    const user = (await (await fetch(`${stub.apiUrl}/user`, { headers })).json()) as { id: number; login: string };
    expect(user).toMatchObject({ id: accountId, login: stored.ownerLogin });
    const emails = (await (await fetch(`${stub.apiUrl}/user/emails`, { headers })).json()) as Array<Record<string, unknown>>;
    expect(emails).toContainEqual({ email: "example-user@example.com", primary: true, verified: true, visibility: "private" });
  });

  it("refuses a token exchange with a wrong client secret as GitHub did", async () => {
    const { clientId } = await createdApp();
    const code = await authorize(clientId, "sign-in");
    const answer = await exchange(clientId, "0".repeat(40), code);
    expect(answer).toMatchObject(answers.tokenExchange.wrongClientSecret);
  });
});
