import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { CookieJar, startSignIn, type SignInHarness } from "./support/sign-in.ts";

// GitHub is the only way to sign in (sign-in: GitHub is the only way to sign
// in; design.md, Technical decisions: T7 and T8; design.md, Self-hosting
// decisions: S4 and S5). The sign-in service signs people in through the user
// authorization of the install's own GitHub App, with the App's client id and
// secret read from the database: it is built from them at start, and rebuilt
// when they change, without a restart. It offers no email and password, no
// passkey and no other provider, and links no second account: a request to
// any other sign-in route answers 404, as the error model answers a route the
// install does not serve, and creates no session. The sign-in page offers
// GitHub only.
//
// Who may sign in is the sign-in capability's rule (sign-in-admission.test.ts):
// here no installation is connected and no invite exists, so only a person who
// is already a member of the install is admitted, and anyone else is refused
// with 403.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ana: StubUser;
let anaUserId: string;

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  stub.addOrg({ login: "acme" });
  ana = stub.addUser({ login: "ana-k", email: "ana@acme.example" });
  anaUserId = await addUser(install.owner, { login: "ana-k", githubAccountId: ana.id });
  harness = await startSignIn(install, stub);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function sessionsOf(userId: string): Promise<number> {
  return Number((await install.owner.query("SELECT count(*) FROM web_sessions WHERE user_id = $1", [userId])).rows[0].count);
}

async function allSessions(): Promise<number> {
  return Number((await install.owner.query("SELECT count(*) FROM web_sessions")).rows[0].count);
}

describe("a sign-in with GitHub", () => {
  it("creates a web session for the member, whose cookie then names them", async () => {
    const before = await sessionsOf(anaUserId);
    const { response, jar } = await harness.signIn("ana-k");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(await sessionsOf(anaUserId)).toBe(before + 1);
    const session = await harness.sessionOf(jar);
    expect(session).toMatchObject({ kind: "web_session", userId: anaUserId });
    const { rows } = await install.owner.query("SELECT id FROM web_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [anaUserId]);
    expect(session?.sessionId).toBe(rows[0].id);
  });

  it("goes through the App's own user authorization, with its client id, and reads who signed in from GitHub", async () => {
    const from = stub.received.length;
    await harness.signIn("ana-k");
    const calls = stub.received.slice(from).map(({ method, path }) => `${method} ${path}`);
    expect(calls).toEqual(["POST /login/oauth/access_token", "GET /user", "GET /user/emails"]);
    const exchange = new URLSearchParams(stub.received[from]?.body ?? "");
    expect(exchange.get("client_id")).toBe(harness.app.clientId);
  });

  it("sends the browser to GitHub's authorize page for the install's App, with the sign-in callback on TIEHALL_URL", async () => {
    const started = await harness.service.page(
      new Request(`${URL_OF_INSTALL}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL },
        body: "return=%2F",
      }),
    );
    expect(started.status).toBe(303);
    const location = new URL(started.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${stub.webUrl}/login/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe(harness.app.clientId);
    expect(location.searchParams.get("redirect_uri")).toBe(`${URL_OF_INSTALL}/api/auth/callback/github`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns to the page the person came from", async () => {
    const jar = new CookieJar();
    const started = await harness.service.page(
      new Request(`${URL_OF_INSTALL}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL },
        body: new URLSearchParams({ return: "/confirm/0b1f5c7e-7c55-4f7a-9d62-2d7c1f3f9a10" }).toString(),
      }),
    );
    jar.take(started);
    const authorize = new URL(started.headers.get("location") ?? "");
    const code = stub.authorize(harness.app, "ana-k", {
      redirectUri: authorize.searchParams.get("redirect_uri") ?? "",
      codeChallenge: authorize.searchParams.get("code_challenge") ?? "",
    });
    const back = await harness.service.handler(
      new Request(`${URL_OF_INSTALL}/api/auth/callback/github?code=${code}&state=${authorize.searchParams.get("state")}`, {
        headers: { cookie: jar.header() },
      }),
    );
    expect(back.headers.get("location")).toBe("/confirm/0b1f5c7e-7c55-4f7a-9d62-2d7c1f3f9a10");
  });

  it("never returns to another site", async () => {
    for (const target of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const page = await harness.service.page(new Request(`${URL_OF_INSTALL}/sign-in?return=${encodeURIComponent(target)}`));
      expect(await page.text()).toContain('name="return" value="/"');
    }
  });

  it("is refused with 403, and starts nothing, from a form on another origin", async () => {
    const started = await harness.service.page(
      new Request(`${URL_OF_INSTALL}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: "return=%2F",
      }),
    );
    expect(started.status).toBe(403);
    expect(started.headers.get("location")).toBeNull();
  });
});

describe("a sign-in while GitHub does not answer", () => {
  // Every call to GitHub waits a bounded time (github-client.ts): the code exchange and the read of who signed
  // in give up after the timeout, and the sign-in fails as it does when GitHub refuses it, with no session.
  it.each(["/login/oauth/access_token", "/user"])("gives up on %s after the timeout, and stores no session", { timeout: 5_000 }, async (path) => {
    const silent = await startSignIn(install, stub, {
      sameAppAs: harness,
      timeoutMs: 200,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== path) return fetch(input, init);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const before = await allSessions();
    const { response, jar } = await silent.signIn("ana-k");
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("error")).not.toBeNull();
    expect(await silent.sessionOf(jar)).toBeUndefined();
    expect(await allSessions()).toBe(before);
  });
});

describe("the sign-in service's rate limit", () => {
  // The sign-in routes are rate limited in every environment, not only in production, by the client address the
  // web role's request guard puts alone in X-Forwarded-For (design.md, Technical decisions: T7): GitHub's return
  // to the callback, the one route served over HTTP, takes 100 calls per 10 seconds from one address, and the
  // next gets the error model's 429 with Retry-After.
  it("answers the 101st call within 10 seconds from one address with 429 and Retry-After, and calls from another address as before", async () => {
    const callback = (address: string) =>
      harness.service.handler(
        new Request(`${URL_OF_INSTALL}/api/auth/callback/github?code=not-a-code&state=not-a-state`, { headers: { "x-forwarded-for": address } }),
      );
    for (let call = 0; call < 100; call += 1) expect((await callback("198.51.100.77")).status, `call ${call + 1}`).not.toBe(429);
    const limited = await callback("198.51.100.77");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("content-type")).toBe("application/problem+json");
    expect(await limited.json()).toMatchObject({ type: "https://tiehall.com/problems/rate-limited", status: 429 });
    expect((await callback("198.51.100.78")).status).not.toBe(429);
  });

  // A refused call creates nothing (sign-in: GitHub is the only way to sign in; github-layer-hardening: D50 (20)):
  // the 101st call is a real return from GitHub of a person an invite admits, which the same call from another
  // address then completes, so the limit alone kept it from signing them in.
  it("creates no session and no user with the 101st call, which the same call from another address then signs in", { timeout: 30_000 }, async () => {
    const neo = stub.addUser({ login: "neo-invited", email: "neo@acme.example" });
    await install.owner.query(
      "INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, expires_at) SELECT id, $1, 'neo-invited', 'member', $2, now() + interval '7 days' FROM orgs",
      [neo.id, anaUserId],
    );
    // Neo starts a sign-in on the sign-in page and authorizes it on GitHub, which sends them back with a code.
    const jar = new CookieJar();
    const started = await harness.service.page(
      new Request(`${URL_OF_INSTALL}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "x-forwarded-for": "198.51.100.80" },
        body: new URLSearchParams({ return: "/" }).toString(),
      }),
    );
    expect(started.status).toBe(303);
    jar.take(started);
    const authorize = new URL(started.headers.get("location") ?? "");
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = authorize.searchParams.get("code_challenge") ?? undefined;
    const back = new URL(redirectUri);
    back.searchParams.set("code", stub.authorize(harness.app, "neo-invited", { redirectUri, ...(codeChallenge === undefined ? {} : { codeChallenge }) }));
    back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const returnFrom = (address: string) => harness.service.handler(new Request(back, { headers: { "x-forwarded-for": address, cookie: jar.header() } }));
    // 100 calls from one address come first.
    for (let call = 0; call < 100; call += 1) {
      const other = await harness.service.handler(
        new Request(`${URL_OF_INSTALL}/api/auth/callback/github?code=not-a-code&state=not-a-state`, { headers: { "x-forwarded-for": "198.51.100.79" } }),
      );
      expect(other.status, `call ${call + 1}`).not.toBe(429);
    }
    const sessions = await allSessions();

    const limited = await returnFrom("198.51.100.79");

    expect(limited.status).toBe(429);
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(await allSessions()).toBe(sessions);
    expect((await install.owner.query("SELECT 1 FROM users WHERE github_login = 'neo-invited'")).rows).toEqual([]);
    expect((await install.owner.query("SELECT 1 FROM sign_in_accounts WHERE account_id = $1", [String(neo.id)])).rows).toEqual([]);
    expect((await install.owner.query("SELECT accepted_at FROM invites WHERE github_login = 'neo-invited'")).rows).toEqual([{ accepted_at: null }]);

    const signedIn = await returnFrom("198.51.100.81");
    expect(signedIn.status).toBe(302);
    jar.take(signedIn);
    expect(await harness.sessionOf(jar)).toMatchObject({ kind: "web_session" });
    expect(await allSessions()).toBe(sessions + 1);
  });
});

describe("a person who may not sign in", () => {
  it("is refused with 403 and the text that says to ask an admin for an invite, and gets no session and no user", async () => {
    const kim = stub.addUser({ login: "kim-outside", email: "kim@acme.example" });
    const sessions = await allSessions();
    const { response, jar } = await harness.signIn("kim-outside");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await response.json()) as { type: string; detail: string };
    expect(problem.type).toBe("https://tiehall.com/problems/sign-in-refused");
    expect(problem.detail).toContain("Ask an admin of the install for an invite");
    expect(await allSessions()).toBe(sessions);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect((await install.owner.query("SELECT 1 FROM users WHERE github_login = 'kim-outside'")).rows).toEqual([]);
    expect((await install.owner.query("SELECT 1 FROM sign_in_accounts WHERE account_id = $1", [String(kim.id)])).rows).toEqual([]);
  });

  it("is refused with 403 when their user is no longer a member, and gets no session", async () => {
    const lee = stub.addUser({ login: "lee-gone" });
    const leeUserId = await addUser(install.owner, { login: "lee-gone", githubAccountId: lee.id, role: null });
    const { response, jar } = await harness.signIn("lee-gone");
    expect(response.status).toBe(403);
    expect(await sessionsOf(leeUserId)).toBe(0);
    expect(await harness.sessionOf(jar)).toBeUndefined();
  });
});

describe("the sign-in routes the install does not serve", () => {
  it.each([
    ["an email-and-password sign-in", "/api/auth/sign-in/email", { email: "ana@acme.example", password: "correct horse battery" }],
    ["an email-and-password sign-up", "/api/auth/sign-up/email", { email: "eve@acme.example", password: "correct horse battery", name: "eve" }],
    ["a passkey sign-in", "/api/auth/sign-in/passkey", { response: { id: "credential", type: "public-key" } }],
    ["a passkey authentication", "/api/auth/passkey/verify-authentication", { response: { id: "credential", type: "public-key" } }],
    ["a magic link", "/api/auth/sign-in/magic-link", { email: "ana@acme.example" }],
    ["an email code", "/api/auth/email-otp/send-verification-otp", { email: "ana@acme.example", type: "sign-in" }],
    ["another provider", "/api/auth/sign-in/social", { provider: "google", callbackURL: "/" }],
  ])("answer %s with 404 and create no session or user", async (_, path, body) => {
    const sessions = await allSessions();
    const users = Number((await install.owner.query("SELECT count(*) FROM users")).rows[0].count);
    const response = await harness.service.handler(
      new Request(`${URL_OF_INSTALL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: URL_OF_INSTALL },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(((await response.json()) as { type: string }).type).toBe("https://tiehall.com/problems/route-not-found");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await allSessions()).toBe(sessions);
    expect(Number((await install.owner.query("SELECT count(*) FROM users")).rows[0].count)).toBe(users);
  });
});

describe("the sign-in page", () => {
  it("offers sign-in with GitHub only, and asks for no password", async () => {
    const page = await harness.service.page(new Request(`${URL_OF_INSTALL}/sign-in`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect([...html.matchAll(/<form\b[^>]*>/g)].map(([form]) => form)).toEqual(['<form method="post" action="/sign-in">']);
    expect([...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label)).toEqual(["Sign in with GitHub"]);
    expect(html).not.toMatch(/type="(?:password|email)"/);
    expect(html.toLowerCase()).not.toMatch(/password|passkey|magic link|google/);
  });

  it("lets its form send the browser on to GitHub, and nowhere else", async () => {
    const page = await harness.service.page(new Request(`${URL_OF_INSTALL}/sign-in`));
    expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' ${stub.webUrl}`);
  });
});

describe("the sign-in service's credentials", () => {
  it("are the stored App's, read again when they change, so the next sign-in uses the new ones without a restart", async () => {
    // A client secret GitHub does not know: GitHub refuses the code exchange, and nobody signs in.
    await harness.storeClientSecret("not-the-apps-secret-0123456789abcdef0123");
    const refused = await harness.signIn("ana-k");
    expect(refused.response.status).toBe(302);
    expect(refused.response.headers.get("location")).toBe("/sign-in?error=invalid_code");
    expect(await harness.sessionOf(refused.jar)).toBeUndefined();

    // The App's own secret again: the very next sign-in succeeds.
    await harness.storeClientSecret(harness.app.clientSecret);
    const signedIn = await harness.signIn("ana-k");
    expect(signedIn.response.status).toBe(302);
    expect(await harness.sessionOf(signedIn.jar)).toMatchObject({ userId: anaUserId });
  });
});
