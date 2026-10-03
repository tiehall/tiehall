import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signAppJwt, startGitHubStub, type GitHubStub, type StubApp, type StubInstallation } from "../src/github/index.ts";

// The GitHub stub's behavior beyond the spike's records (design.md, Technical
// decisions: T17; design.md of github-app-reachability, Technical decisions:
// T4): GitHub's refusals of manifests, the App's installations and their
// repositories with GitHub's paging, installation tokens of any length, user
// authorization with refresh tokens, organization membership, pull requests,
// issues written as the App's bot, and signed webhook deliveries that a test
// can send, drop and redeliver, with the App's delivery log.

let stub: GitHubStub;

beforeEach(async () => {
  stub = await startGitHubStub();
  stub.addUser({ login: "omar", name: "Omar", email: "omar@acme.example" });
  stub.addUser({ login: "lee", name: "Lee", email: "lee@acme.example" });
  stub.addUser({ login: "outsider" });
  stub.addOrg({ login: "acme", members: { omar: "admin", lee: "member" } });
  stub.addRepo("acme/web");
  stub.addRepo("acme/api");
  stub.addRepo("acme/tools");
  stub.signIn("omar");
});

afterEach(async () => {
  await stub.close();
});

const PERMISSIONS = { metadata: "read", pull_requests: "read", issues: "write", members: "read", emails: "read" } as const;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Tiehall tiehall.example.com",
    url: "https://tiehall.example.com",
    redirect_url: "https://tiehall.example.com/setup/github/app",
    callback_urls: ["https://tiehall.example.com/api/auth/callback/github"],
    public: false,
    default_permissions: PERMISSIONS,
    hook_attributes: { url: "https://tiehall.example.com/webhooks/github", active: true },
    default_events: ["pull_request", "issues", "organization"],
    ...overrides,
  };
}

function jwtFor(app: StubApp): string {
  return signAppJwt({ privateKey: app.pem, issuer: app.clientId });
}

async function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${stub.apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...(init.headers as Record<string, string>) },
  });
}

async function installationToken(app: StubApp, installation: StubInstallation): Promise<string> {
  const response = await api(`/app/installations/${installation.id}/access_tokens`, jwtFor(app), { method: "POST" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

/** A local HTTP server that plays the install's /webhooks/github. */
async function hookReceiver(status = 202): Promise<{
  url: string;
  received: Array<{ headers: IncomingMessage["headers"]; body: string }>;
  close: () => Promise<void>;
  setStatus: (next: number) => void;
}> {
  const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
  let answer = status;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/webhooks/github`,
    received,
    setStatus: (next) => {
      answer = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("manifests", () => {
  async function post(body: Record<string, unknown>, path = "/settings/apps/new"): Promise<{ status: number; page: string; messages: string[] }> {
    const response = await fetch(`${stub.webUrl}${path}?state=s`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ manifest: JSON.stringify(body) }),
      redirect: "manual",
    });
    const page = await response.text();
    return {
      status: response.status,
      page,
      messages: [...page.matchAll(/<li class="error">([^<]*)<\/li>/g)].map(([, text]) => text!.replaceAll("&#39;", "'")),
    };
  }

  it("refuses a hook URL on localhost whether the hook is active or not", async () => {
    for (const active of [true, false]) {
      const { messages } = await post(manifest({ hook_attributes: { url: "http://localhost:3000/webhooks/github", active } }));
      expect(messages).toEqual([
        "Hook url is not supported because it isn't reachable over the public Internet (localhost)",
        "Hook is invalid",
      ]);
    }
  });

  it("refuses either installation event in the default events", async () => {
    for (const event of ["installation", "installation_repositories"]) {
      const { messages } = await post(manifest({ default_events: ["pull_request", event] }));
      expect(messages).toEqual([`Default events unsupported: ${event}`, `Default events are not supported by permissions: ${event}`]);
    }
  });

  it("refuses events without a hook URL", async () => {
    const { messages } = await post(manifest({ hook_attributes: undefined }));
    expect(messages).toEqual(["Hook url cannot be blank", "Hook is invalid"]);
  });

  it("refuses an event whose permission the manifest does not ask for", async () => {
    const { messages } = await post(manifest({ default_events: ["pull_request", "push"] }));
    expect(messages).toEqual(["Default events are not supported by permissions: push"]);
  });

  it("refuses a hook URL a test names as unreachable, with the same page", async () => {
    stub.refuseHookUrl("https://tiehall.example.com/webhooks/github");
    const { page, messages } = await post(manifest());
    expect(page).toContain("Invalid GitHub App configuration");
    expect(messages).toEqual([
      "Hook url is not supported because it isn't reachable over the public Internet (tiehall.example.com)",
      "Hook is invalid",
    ]);
    expect(stub.apps()).toHaveLength(0);
  });

  it("accepts a manifest with a reachable hook, and one with no hook and no events", async () => {
    expect((await post(manifest())).messages).toEqual([]);
    expect((await post(manifest({ hook_attributes: undefined, default_events: [] }))).messages).toEqual([]);
  });

  it("posts to an organization's new-App page only for an owner of the organization", async () => {
    expect((await post(manifest(), "/organizations/acme/settings/apps/new")).page).toContain("Create GitHub App for acme");
    stub.signIn("lee");
    expect((await post(manifest(), "/organizations/acme/settings/apps/new")).status).toBe(404);
  });

  it("creates the App with a webhook secret when it has a hook, and pings the hook", async () => {
    const receiver = await hookReceiver();
    try {
      const created = await stub.createAppFromManifest({
        manifest: manifest({ hook_attributes: { url: receiver.url, active: true } }),
        org: "acme",
        state: "s",
      });
      if (created.status !== "created") throw new Error(created.messages.join("; "));
      expect(created.location.searchParams.get("state")).toBe("s");
      const conversion = (await (
        await fetch(`${stub.apiUrl}/app-manifests/${created.code}/conversions`, { method: "POST" })
      ).json()) as { webhook_secret: string; owner: { login: string; type: string } };
      expect(conversion.webhook_secret).toMatch(/^[0-9a-f]{40}$/);
      expect(conversion.owner).toMatchObject({ login: "acme", type: "Organization" });
      await stub.settled();
      expect(receiver.received.map((delivery) => delivery.headers["x-github-event"])).toEqual(["ping"]);
    } finally {
      await receiver.close();
    }
  });

  it("keeps App names unique", async () => {
    await stub.createAppFromManifest({ manifest: manifest(), state: "s" });
    const second = await stub.createAppFromManifest({ manifest: manifest(), state: "s" });
    expect(second).toMatchObject({ status: "refused", messages: ["Name has already been taken"] });
  });
});

describe("the App JWT", () => {
  it("accepts the client id or the App id as the issuer", async () => {
    const app = stub.createApp({ owner: "acme" });
    for (const issuer of [app.clientId, app.id, String(app.id)]) {
      expect((await api("/app", signAppJwt({ privateKey: app.pem, issuer }))).status).toBe(200);
    }
  });

  it("refuses a JWT signed with another key, an expired one and one that lives too long", async () => {
    const app = stub.createApp({ owner: "acme" });
    const other = stub.createApp({ owner: "acme", name: "Other" });
    const now = Math.floor(Date.now() / 1000);
    const refused = [
      signAppJwt({ privateKey: other.pem, issuer: app.clientId }),
      signAppJwt({ privateKey: app.pem, issuer: app.clientId, now: now - 1_200 }),
      signAppJwt({ privateKey: app.pem, issuer: app.clientId, lifetimeSeconds: 3_600 }),
      "not-a-jwt",
    ];
    for (const jwt of refused) {
      const response = await api("/app", jwt);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { message: string }).message).toBeTruthy();
    }
  });

  it("accepts a JWT signed with each key the App has, until the key is deleted, as its settings page rotates keys", async () => {
    const app = stub.createApp({ owner: "acme" });
    const first = app.pem;
    const second = stub.addPrivateKey(app);
    expect(second).not.toBe(first);
    for (const key of [first, second]) expect((await api("/app", signAppJwt({ privateKey: key, issuer: app.clientId }))).status).toBe(200);

    stub.deletePrivateKey(app, first);

    expect((await api("/app", signAppJwt({ privateKey: first, issuer: app.clientId }))).status).toBe(401);
    expect((await api("/app", signAppJwt({ privateKey: second, issuer: app.clientId }))).status).toBe(200);
    expect(() => stub.deletePrivateKey(app, first)).toThrow();
  });
});

describe("installations", () => {
  it("lists every installation, pages them by the Link header, and marks a suspended one", async () => {
    const app = stub.createApp({ owner: "acme", public: true });
    const made: StubInstallation[] = [];
    for (let index = 0; index < 101; index += 1) {
      const login = `org-${index}`;
      stub.addUser({ login: `owner-${index}` });
      stub.addOrg({ login, members: { [`owner-${index}`]: "admin" } });
      made.push(await stub.install(app, { account: login, repositories: "all", by: `owner-${index}` }));
    }
    await stub.suspend(made[7]!);

    const first = await api("/app/installations", jwtFor(app));
    expect(((await first.json()) as unknown[]).length).toBe(30);
    expect(first.headers.get("link")).toContain('rel="next"');

    const seen: Array<{ id: number; suspended_at: string | null }> = [];
    let url: string | undefined = `${stub.apiUrl}/app/installations?per_page=100`;
    let pages = 0;
    while (url !== undefined) {
      const response = await fetch(url, { headers: { authorization: `Bearer ${jwtFor(app)}` } });
      seen.push(...((await response.json()) as typeof seen));
      pages += 1;
      url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    }
    expect(pages).toBe(2);
    expect(seen.map((installation) => installation.id).sort()).toEqual(made.map((installation) => installation.id).sort());
    expect(seen.find((installation) => installation.id === made[7]!.id)!.suspended_at).toMatch(/Z$/);
    expect(seen.filter((installation) => installation.suspended_at !== null)).toHaveLength(1);

    const clamped = await api("/app/installations?per_page=500", jwtFor(app));
    expect(((await clamped.json()) as unknown[]).length).toBe(100);
  });

  it("lists an installation's repositories to its token, paged, and follows added and removed repositories", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const token = await installationToken(app, installation);
    const names = async (): Promise<string[]> => {
      const response = await api("/installation/repositories", token);
      const body = (await response.json()) as { total_count: number; repositories: Array<{ full_name: string }> };
      expect(body.total_count).toBe(body.repositories.length);
      return body.repositories.map((repository) => repository.full_name).sort();
    };
    expect(await names()).toEqual(["acme/web"]);
    await stub.addRepositories(installation, ["acme/api"], { delivery: "none" });
    expect(await names()).toEqual(["acme/api", "acme/web"]);
    await stub.removeRepositories(installation, ["acme/web"], { delivery: "none" });
    expect(await names()).toEqual(["acme/api"]);

    for (let index = 0; index < 40; index += 1) stub.addRepo(`acme/extra-${index}`);
    const all = await stub.install(stub.createApp({ owner: "acme", name: "All" }), { account: "acme", repositories: "all" });
    const allToken = await installationToken(stub.app(all.appId), all);
    const page = await api("/installation/repositories", allToken);
    expect(((await page.json()) as { repositories: unknown[]; total_count: number }).repositories).toHaveLength(30);
    expect(page.headers.get("link")).toMatch(/page=2>; rel="next"/);
  });

  it("refuses tokens for a suspended installation and forgets a deleted one", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    await stub.suspend(installation, { delivery: "none" });
    expect((await api(`/app/installations/${installation.id}/access_tokens`, jwtFor(app), { method: "POST" })).status).toBe(403);
    expect((await api("/installation/repositories", token)).status).toBe(403);
    await stub.unsuspend(installation, { delivery: "none" });
    expect((await api("/installation/repositories", token)).status).toBe(200);
    await stub.uninstall(installation, { delivery: "none" });
    expect((await api("/installation/repositories", token)).status).toBe(401);
    expect((await api(`/app/installations/${installation.id}/access_tokens`, jwtFor(app), { method: "POST" })).status).toBe(404);
    expect(await (await api("/app/installations", jwtFor(app))).json()).toEqual([]);
  });

  it("installs from GitHub's install page, on the owner only while the App is private", async () => {
    const app = stub.createApp({ owner: "acme" });
    const page = await (await fetch(`${stub.webUrl}/apps/${app.slug}/installations/new`)).text();
    expect(page).toContain("acme");
    expect(page).toContain("Members");
    const response = await fetch(`${stub.webUrl}/apps/${app.slug}/installations`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ account: "acme", repository_selection: "selected", repositories: "acme/web" }),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(stub.installations(app)).toHaveLength(1);
    expect(stub.installations(app)[0]!.repositoryNames()).toEqual(["acme/web"]);

    const personal = await fetch(`${stub.webUrl}/apps/${app.slug}/installations`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ account: "omar", repository_selection: "all" }),
      redirect: "manual",
    });
    expect(personal.status).toBe(404);
  });
});

describe("installation tokens", () => {
  it("are ghs_ followed by letters, digits, _, - and ., 520 characters by default, and of any length a test asks for", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    expect(token).toHaveLength(520);
    expect(token).toMatch(/^ghs_[A-Za-z0-9_.-]+$/);
    for (const mark of ["_", "-", "."]) expect(token.slice(4)).toContain(mark);
    stub.setInstallationTokenLength(2_048);
    const long = await installationToken(app, installation);
    expect(long).toHaveLength(2_048);
    expect((await api("/installation/repositories", long)).status).toBe(200);
    expect(stub.tokenKind(long)).toBe("installation");
  });

  it("expire after an hour", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    stub.expireInstallationTokens();
    const response = await api("/installation/repositories", token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: "Bad credentials" });
  });

  it("are recorded on every call exactly as issued", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    await fetch(`${stub.apiUrl}/repos/acme/web`, { headers: { authorization: `token ${token}` } });
    const recorded = stub.received.filter((request) => request.path === "/repos/acme/web");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.headers["authorization"]).toBe(`token ${token}`);
    expect(recorded[0]!.token).toEqual({ kind: "installation", value: token });
  });
});

describe("user authorization", () => {
  async function signInCode(app: StubApp, login: string): Promise<string> {
    stub.signIn(login);
    const query = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.callbackUrls[0]!, state: "s" });
    const first = await fetch(`${stub.webUrl}/login/oauth/authorize?${query}`, { redirect: "manual" });
    if (first.status === 302) return new URL(first.headers.get("location")!).searchParams.get("code")!;
    const page = await first.text();
    expect(page).toContain(`Authorize ${app.name}`);
    const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)"/g)].map(([, name, value]) => [name!, value!]));
    const approved = await fetch(`${stub.webUrl}/login/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, authorize: "1" }),
      redirect: "manual",
    });
    return new URL(approved.headers.get("location")!).searchParams.get("code")!;
  }

  async function tokenRequest(body: Record<string, string>, accept = "application/json"): Promise<Response> {
    return fetch(`${stub.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }

  it("asks only the first time, then sends the browser straight back", async () => {
    const app = stub.createApp({ owner: "acme" });
    await signInCode(app, "lee");
    const query = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.callbackUrls[0]!, state: "again" });
    const again = await fetch(`${stub.webUrl}/login/oauth/authorize?${query}`, { redirect: "manual", headers: { cookie: "stub_user=lee" } });
    expect(again.status).toBe(302);
  });

  it("refuses a redirect URI that is not the App's callback URL", async () => {
    const app = stub.createApp({ owner: "acme" });
    const query = new URLSearchParams({ client_id: app.clientId, redirect_uri: "https://evil.example/callback", state: "s" });
    const response = await fetch(`${stub.webUrl}/login/oauth/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("redirect_uri_mismatch");
  });

  it("takes a code once, answers as a form unless JSON is asked for, and refreshes a token once", async () => {
    const app = stub.createApp({ owner: "acme" });
    const code = await signInCode(app, "lee");
    const credentials = { client_id: app.clientId, client_secret: app.clientSecret };
    const form = await tokenRequest({ ...credentials, code }, "*/*");
    const answer = new URLSearchParams(await form.text());
    expect(answer.get("access_token")).toMatch(/^ghu_[A-Za-z0-9]{36}$/);
    expect(answer.get("refresh_token")).toMatch(/^ghr_[A-Za-z0-9]{76}$/);

    const reused = (await (await tokenRequest({ ...credentials, code })).json()) as Record<string, string>;
    expect(reused["error"]).toBe("bad_verification_code");

    const refreshed = (await (
      await tokenRequest({ ...credentials, grant_type: "refresh_token", refresh_token: answer.get("refresh_token")! })
    ).json()) as Record<string, string>;
    expect(refreshed["access_token"]).toMatch(/^ghu_/);
    expect(refreshed["refresh_token"]).not.toBe(answer.get("refresh_token"));
    const again = (await (
      await tokenRequest({ ...credentials, grant_type: "refresh_token", refresh_token: answer.get("refresh_token")! })
    ).json()) as Record<string, string>;
    expect(again["error"]).toBe("bad_refresh_token");
    // Refreshing ends the old access token.
    expect((await api("/user", answer.get("access_token")!)).status).toBe(401);
    expect((await api("/user", refreshed["access_token"]!)).status).toBe(200);
  });

  it("checks PKCE when the authorization asked for it", async () => {
    const app = stub.createApp({ owner: "acme" });
    const verifier = "v".repeat(50);
    const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
    const code = await stub.authorize(app, "lee", { redirectUri: app.callbackUrls[0]!, codeChallenge: challenge });
    const credentials = { client_id: app.clientId, client_secret: app.clientSecret };
    expect(((await (await tokenRequest({ ...credentials, code, code_verifier: "w".repeat(50) })).json()) as Record<string, string>)["error"]).toBe(
      "bad_verification_code",
    );
    const code2 = await stub.authorize(app, "lee", { redirectUri: app.callbackUrls[0]!, codeChallenge: challenge });
    expect(((await (await tokenRequest({ ...credentials, code: code2, code_verifier: verifier })).json()) as Record<string, string>)["access_token"]).toMatch(/^ghu_/);
  });

  it("follows a login rename by account id, and a changed primary email", async () => {
    const app = stub.createApp({ owner: "acme" });
    const tokens = await stub.userTokens(app, "lee");
    const before = (await (await api("/user", tokens.accessToken)).json()) as { id: number; login: string };
    stub.renameUser("lee", "lee-renamed");
    stub.setEmails("lee-renamed", [{ email: "lee@new.example", primary: true, verified: true, visibility: "private" }]);
    const after = (await (await api("/user", tokens.accessToken)).json()) as { id: number; login: string };
    expect(after).toEqual(expect.objectContaining({ id: before.id, login: "lee-renamed" }));
    expect((await (await api(`/user/${before.id}`, tokens.accessToken)).json()) as { login: string }).toMatchObject({ login: "lee-renamed" });
    expect((await api("/users/lee", tokens.accessToken)).status).toBe(404);
    const emails = (await (await api("/user/emails", tokens.accessToken)).json()) as Array<{ email: string }>;
    expect(emails.map((email) => email.email)).toEqual(["lee@new.example"]);
  });

  it("refuses /user/emails to an App without the Email addresses permission", async () => {
    const app = stub.createApp({ owner: "acme", permissions: { metadata: "read" } });
    const tokens = await stub.userTokens(app, "lee");
    const response = await api("/user/emails", tokens.accessToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: "Resource not accessible by integration" });
  });
});

describe("organization membership", () => {
  it("answers membership lookups to an organization installation's token", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    expect((await api("/orgs/acme/members/lee", token)).status).toBe(204);
    expect((await api("/orgs/acme/members/outsider", token)).status).toBe(404);
    const membership = (await (await api("/orgs/acme/memberships/omar", token)).json()) as { state: string; role: string };
    expect(membership).toMatchObject({ state: "active", role: "admin" });
    expect((await api("/orgs/acme/memberships/outsider", token)).status).toBe(404);
    const members = (await (await api("/orgs/acme/members", token)).json()) as Array<{ login: string }>;
    expect(members.map((member) => member.login).sort()).toEqual(["lee", "omar"]);

    await stub.removeMember("acme", "lee", { delivery: "none" });
    expect((await api("/orgs/acme/members/lee", token)).status).toBe(404);
  });

  it("refuses them to a personal installation and to another organization's installation", async () => {
    stub.addOrg({ login: "other", members: { omar: "admin" } });
    const app = stub.createApp({ owner: "omar", public: true });
    const personal = await stub.install(app, { account: "omar", repositories: "all" });
    const personalToken = await installationToken(app, personal);
    expect((await api("/orgs/acme/members/lee", personalToken)).status).toBe(403);
    const other = await stub.install(app, { account: "other", repositories: "all" });
    const otherToken = await installationToken(app, other);
    expect((await api("/orgs/acme/members/lee", otherToken)).status).toBe(403);
  });
});

// GitHub documents what a requester that may not see an organization's members gets: `GET
// /orgs/{org}/members/{username}` answers 302, to `/orgs/{org}/public_members/{username}`, which answers 204 for a
// public member and 404 for anyone else, and `GET /orgs/{org}/members` lists the public members only. An
// installation's token is such a requester without the Members permission, and for an organization that is not the
// installation's own. The stub answers so once a test asks for GitHub's documented answers; until then it refuses
// such calls with 403, which tests of the rest rely on.
describe("organization membership, as GitHub answers a requester that may not see the members", () => {
  async function publicOnly(token: string) {
    const redirect = await api("/orgs/acme/members/lee", token, { redirect: "manual" });
    return {
      redirect: redirect.status,
      location: redirect.headers.get("location"),
      lee: (await api("/orgs/acme/members/lee", token)).status,
      omar: (await api("/orgs/acme/members/omar", token)).status,
      listed: ((await (await api("/orgs/acme/members", token)).json()) as Array<{ login: string }>).map(({ login }) => login),
    };
  }
  const PUBLIC_ONLY = { redirect: 302, lee: 404, omar: 204, listed: ["omar"] };

  beforeEach(() => {
    stub.setMemberAnswers("documented");
    stub.setMembershipPublic("acme", "omar", true);
  });

  it("serves a token GitHub issued without the Members permission the public members only", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    stub.setInstallationPermissions(installation, { metadata: "read", issues: "write", pull_requests: "read" });
    const response = await api(`/app/installations/${installation.id}/access_tokens`, jwtFor(app), { method: "POST" });
    const issued = (await response.json()) as { token: string; permissions: Record<string, string> };
    expect(issued.permissions["members"]).toBeUndefined();
    const answers = await publicOnly(issued.token);
    expect(answers).toMatchObject(PUBLIC_ONLY);
    expect(answers.location).toBe(`${stub.apiUrl}/orgs/acme/public_members/lee`);
  });

  it("serves another organization's installation the public members only", async () => {
    stub.addOrg({ login: "other", members: { omar: "admin" } });
    const app = stub.createApp({ owner: "omar", public: true });
    const other = await stub.install(app, { account: "other", repositories: "all" });
    expect(await publicOnly(await installationToken(app, other))).toMatchObject(PUBLIC_ONLY);
  });

  it("serves every token the public members only while GitHub hides an organization's members, whatever permissions it was issued with", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    expect((await api("/orgs/acme/members/lee", token)).status).toBe(204);
    stub.setMembersPublicOnly("acme", true);
    expect(await publicOnly(token)).toMatchObject(PUBLIC_ONLY);
  });

  it("answers by the organization that holds the login now, after a rename and another organization took the old login", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    const renamed = stub.renameOrg("acme", "acme-inc");
    const taker = stub.addOrg({ login: "acme", members: { outsider: "member" } });
    stub.setMembershipPublic("acme", "outsider", true);
    expect(((await (await api("/users/acme", token)).json()) as { id: number }).id).toBe(taker.id);
    expect(((await (await api("/orgs/acme/members", token)).json()) as Array<{ login: string }>).map(({ login }) => login)).toEqual(["outsider"]);
    expect((await api("/orgs/acme/members/outsider", token, { redirect: "manual" })).status).toBe(302);
    expect((await api("/orgs/acme-inc/members/lee", token)).status).toBe(204);
    expect(renamed.id).not.toBe(taker.id);
  });
});

describe("pull requests and issues", () => {
  it("serves a covered repository's pull requests, and answers an unchanged list as not modified", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const token = await installationToken(app, installation);
    const pr = await stub.openPullRequest("acme/web", { title: "FE-142: fix", head: "fe-142-fix", author: "lee" });
    const listed = await api("/repos/acme/web/pulls?state=all&sort=updated&direction=desc", token);
    expect(((await listed.json()) as Array<{ number: number }>).map((item) => item.number)).toEqual([pr.number]);
    const etag = listed.headers.get("etag")!;
    expect((await api("/repos/acme/web/pulls?state=all&sort=updated&direction=desc", token, { headers: { "if-none-match": etag } })).status).toBe(304);

    await stub.mergePullRequest("acme/web", pr.number, { by: "omar" });
    const merged = (await (await api(`/repos/acme/web/pulls/${pr.number}`, token)).json()) as { merged: boolean; state: string; merged_at: string };
    expect(merged).toMatchObject({ merged: true, state: "closed" });
    expect((await api("/repos/acme/web/pulls?state=all&sort=updated&direction=desc", token, { headers: { "if-none-match": etag } })).status).toBe(200);
    expect((await api("/repos/acme/api/pulls", token)).status).toBe(404);
  });

  it("writes issues, comments and labels as the App's bot, and lists issues updated since a time", async () => {
    const app = stub.createApp({ owner: "acme" });
    const installation = await stub.install(app, { account: "acme", repositories: ["acme/web"] });
    const token = await installationToken(app, installation);
    const created = await api("/repos/acme/web/issues", token, {
      method: "POST",
      body: JSON.stringify({ title: "FE-142", body: "Mirrored by Tiehall", labels: ["tiehall:open"] }),
    });
    expect(created.status).toBe(201);
    const issue = (await created.json()) as { number: number; user: { login: string; type: string }; labels: Array<{ name: string }> };
    expect(issue.user).toMatchObject({ login: `${app.slug}[bot]`, type: "Bot" });
    expect(issue.labels.map((label) => label.name)).toEqual(["tiehall:open"]);

    const comment = await api(`/repos/acme/web/issues/${issue.number}/comments`, token, { method: "POST", body: JSON.stringify({ body: "Claimed" }) });
    expect(((await comment.json()) as { user: { login: string } }).user.login).toBe(`${app.slug}[bot]`);
    await api(`/repos/acme/web/issues/${issue.number}/labels`, token, { method: "POST", body: JSON.stringify({ labels: ["tiehall:claimed"] }) });
    await api(`/repos/acme/web/issues/${issue.number}/labels/tiehall%3Aopen`, token, { method: "DELETE" });
    const closed = await api(`/repos/acme/web/issues/${issue.number}`, token, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    });
    expect(await closed.json()).toMatchObject({ state: "closed", state_reason: "not_planned", labels: [{ name: "tiehall:claimed" }] });

    const since = new Date(Date.now() - 60_000).toISOString();
    const updated = (await (await api(`/repos/acme/web/issues?state=all&since=${since}`, token)).json()) as Array<{ number: number }>;
    expect(updated.map((item) => item.number)).toContain(issue.number);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await (await api(`/repos/acme/web/issues?state=all&since=${future}`, token)).json()).toEqual([]);
  });

  it("refuses issue writes to an App without write access to issues", async () => {
    const app = stub.createApp({ owner: "acme", permissions: { metadata: "read", issues: "read" } });
    const installation = await stub.install(app, { account: "acme", repositories: "all" });
    const token = await installationToken(app, installation);
    const response = await api("/repos/acme/web/issues", token, { method: "POST", body: JSON.stringify({ title: "x" }) });
    expect(response.status).toBe(403);
  });
});

describe("webhook deliveries", () => {
  it("signs each delivery with the App's webhook secret and logs it", async () => {
    const receiver = await hookReceiver();
    try {
      const app = stub.createApp({ owner: "acme", hook: { url: receiver.url, active: true } });
      await stub.install(app, { account: "acme", repositories: ["acme/web"] });
      await stub.openPullRequest("acme/web", { title: "FE-142", head: "fe-142", author: "lee" });
      await stub.settled();
      const events = receiver.received.map((delivery) => delivery.headers["x-github-event"]);
      expect(events).toEqual(["ping", "installation", "pull_request"]);
      for (const delivery of receiver.received) {
        const expected = `sha256=${createHmac("sha256", app.webhookSecret!).update(delivery.body).digest("hex")}`;
        expect(delivery.headers["x-hub-signature-256"]).toBe(expected);
        expect(delivery.headers["x-github-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
      }
      const logged = await (await api("/app/hook/deliveries", jwtFor(app))).json();
      expect(logged).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "pull_request", action: "opened", status: "OK", status_code: 202 })]),
      );
    } finally {
      await receiver.close();
    }
  });

  it("sends the installation events without subscribing, and nothing for events the App did not subscribe to", async () => {
    const receiver = await hookReceiver();
    try {
      const app = stub.createApp({ owner: "acme", hook: { url: receiver.url, active: true }, events: [] });
      const installation = await stub.install(app, { account: "acme", repositories: ["acme/web"] });
      await stub.addRepositories(installation, ["acme/api"]);
      await stub.openPullRequest("acme/web", { title: "x", head: "x", author: "lee" });
      await stub.settled();
      expect(receiver.received.map((delivery) => delivery.headers["x-github-event"])).toEqual(["ping", "installation", "installation_repositories"]);
    } finally {
      await receiver.close();
    }
  });

  it("drops a delivery when asked, logs it as failed, and redelivers it through the API", async () => {
    const receiver = await hookReceiver();
    try {
      const app = stub.createApp({ owner: "acme", hook: { url: receiver.url, active: true } });
      const installation = await stub.install(app, { account: "acme", repositories: "all" }, { delivery: "drop" });
      await stub.settled();
      expect(receiver.received.map((delivery) => delivery.headers["x-github-event"])).toEqual(["ping"]);
      const failed = stub.deliveries(app).find((delivery) => delivery.event === "installation")!;
      expect(failed.statusCode).not.toBeGreaterThanOrEqual(200);

      const redelivered = await api(`/app/hook/deliveries/${failed.id}/attempts`, jwtFor(app), { method: "POST" });
      expect(redelivered.status).toBe(202);
      await stub.settled();
      const second = receiver.received.at(-1)!;
      expect(second.headers["x-github-event"]).toBe("installation");
      expect(second.headers["x-github-delivery"]).toBe(failed.guid);
      const log = (await (await api("/app/hook/deliveries", jwtFor(app))).json()) as Array<{ guid: string; redelivery: boolean; status_code: number }>;
      expect(log.filter((delivery) => delivery.guid === failed.guid).map((delivery) => delivery.redelivery).sort()).toEqual([false, true]);
      const detail = (await (await api(`/app/hook/deliveries/${failed.id}`, jwtFor(app))).json()) as { request: { payload: { installation: { id: number } } } };
      expect(detail.request.payload.installation.id).toBe(installation.id);
    } finally {
      await receiver.close();
    }
  });

  it("logs a delivery to a hook URL it cannot reach as failed, and one that answers an error with its status", async () => {
    const receiver = await hookReceiver(500);
    try {
      const reachable = stub.createApp({ owner: "acme", hook: { url: receiver.url, active: true } });
      await stub.install(reachable, { account: "acme", repositories: "all" });
      const unreachable = stub.createApp({ owner: "acme", name: "Far", hook: { url: "https://tiehall.example.com/webhooks/github", active: true } });
      await stub.install(unreachable, { account: "acme", repositories: "all" });
      await stub.settled();
      expect(stub.deliveries(reachable).find((delivery) => delivery.event === "installation")).toMatchObject({
        statusCode: 500,
        status: "Invalid HTTP Response: 500",
      });
      expect(stub.deliveries(unreachable).find((delivery) => delivery.event === "installation")!.statusCode).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  it("sends nothing and logs nothing for an App without a webhook", async () => {
    const app = stub.createApp({ owner: "acme", hook: null, events: [] });
    await stub.install(app, { account: "acme", repositories: "all" });
    await stub.settled();
    expect(stub.deliveries(app)).toEqual([]);
    expect((await api("/app/hook/deliveries", jwtFor(app))).status).toBe(404);
  });

  it("sends the organization event for a member who leaves", async () => {
    const receiver = await hookReceiver();
    try {
      const app = stub.createApp({ owner: "acme", hook: { url: receiver.url, active: true } });
      await stub.install(app, { account: "acme", repositories: "all" });
      await stub.removeMember("acme", "lee");
      await stub.settled();
      const last = JSON.parse(receiver.received.at(-1)!.body) as { action: string; membership: { user: { login: string } } };
      expect(receiver.received.at(-1)!.headers["x-github-event"]).toBe("organization");
      expect(last).toMatchObject({ action: "member_removed", membership: { user: { login: "lee" } } });
    } finally {
      await receiver.close();
    }
  });
});

describe("the rewriting fetch", () => {
  it("sends github.com and api.github.com to the stub and nothing else", async () => {
    const app = stub.createApp({ owner: "acme" });
    const response = await stub.fetch("https://api.github.com/app", { headers: { authorization: `Bearer ${jwtFor(app)}` } });
    expect(response.status).toBe(200);
    const page = await stub.fetch(`https://github.com/apps/${app.slug}`);
    expect(page.status).toBe(200);
    await expect(stub.fetch("https://example.com/")).rejects.toThrow(/stub/);
  });
});
