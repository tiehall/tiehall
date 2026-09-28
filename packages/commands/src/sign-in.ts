import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";
import type { GithubProfile } from "better-auth/social-providers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { githubApp, integrationSecrets, members, orgs, signInAccounts, signInVerifications, users, webSessions, type Database } from "@tiehall/db";
import type { WebSessionCaller } from "./caller.ts";
import { GITHUB_API_URL } from "./github-client.ts";
import { SIGN_IN_CALLBACK_PATH } from "./github-manifest.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { readSecret } from "./integration-secrets.ts";
import { createLogger, type Logger } from "./log.ts";
import { createGitHubFetch } from "./outbound.ts";
import type { SecretBox } from "./secret-box.ts";
import { GITHUB_WEB_URL } from "./setup-github.ts";
import { RemovedMemberError } from "./with-org.ts";

// The sign-in service (sign-in: GitHub is the only way to sign in; design.md,
// Technical decisions: T7 and T8; design.md, Self-hosting decisions: S4 and
// S5). People sign in with GitHub only, through the user authorization of the
// install's own GitHub App: Better Auth's GitHub provider with the App's client
// id and secret, which exist only once the setup screen has stored them. So
// the service is built from the stored credentials when it is first used, and
// built again when they change: each request reads which credentials are
// stored, and the first request after a change is served by an instance built
// from the new ones, without a restart.
//
// What it offers is only that: no email and password, no passkey, no other
// provider, and no account linking, so a Tiehall user has exactly one GitHub
// account. Better Auth's other routes still exist, and some answer even with
// their flow switched off, so a route guard in front of all of them refuses,
// with 404 as the error model answers a route the install does not serve,
// every route that is not on its allowlist: over HTTP the service answers only
// GitHub's return to the sign-in callback. The sign-in page and sign-out are
// Tiehall's own pages, which call the service in the same process.
//
// Better Auth keeps its records in Tiehall's tables: a user is a row of
// `users`, whose login is the name Better Auth keeps; a web session is a row
// of `web_sessions`; the link between a user and their GitHub account is a row
// of `sign_in_accounts`; and a sign-in's state between the redirect to GitHub
// and GitHub's return is a row of `sign_in_verifications`. Better Auth finds a
// person by their GitHub account's numeric id, and the "email" it keeps is
// `github:` and that id, never an email address, so no one's email address can
// ever lead it to another person's user (sign-in: One Tiehall user per GitHub
// account). The email address Tiehall keeps is the account's primary verified
// one, which each sign-in reads from GitHub.
//
// Tiehall keeps no GitHub user token (sign-in: Tiehall keeps no GitHub user
// token): the App issues expiring user tokens, an access token and a refresh
// token, and Better Auth would store them with the linked account. The access
// token serves only to learn who signed in; a hook before each write of the
// account, at the first sign-in and at every later one, sets every token field
// and both expiries to null. An after-hook cannot change the row, so it is the
// pair of before-hooks (design.md, Technical decisions: T7), and the database
// refuses a stored token besides.
//
// Who may sign in (sign-in: Who may sign in): every sign-in is decided before
// the service writes anything, and a refused one gets 403 sign-in-refused,
// telling the person to ask an admin for an invite, and creates no session, no
// user and no membership. For now a person is admitted when their user is
// already a member of the install; the sign-in that completes setup (task 7.9)
// and organization members and invites (task 7.10) join the rule when they are
// built.

/** Where the sign-in service's own routes live, such as GitHub's return to the sign-in callback. */
export const AUTH_BASE_PATH = "/api/auth";
/** The sign-in page: GET shows it, POST starts a sign-in with GitHub. */
export const SIGN_IN_PATH = "/sign-in";

/**
 * The routes of the sign-in service that anyone may reach over HTTP, by method
 * and the route's path under AUTH_BASE_PATH, with the one value each of its
 * parameters may take: GitHub's return to the sign-in callback.
 */
const HTTP_ALLOWLIST: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([["GET /callback/:id", { id: "github" }]]);

/** What a refused person reads. */
export const SIGN_IN_REFUSED =
  "Your GitHub account may not sign in to this install. Ask an admin of the install for an invite, then sign in again.";

/** What every write of a linked account stores in place of the user tokens GitHub issued: nothing. */
const NO_USER_TOKEN = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;

/** The code Better Auth carries a refusal under, from the admission check to the callback's answer. */
const REFUSED_CODE = "sign_in_refused";

export interface SignInServiceOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the service's cookies; read when the service is first built. */
  secret: () => string;
  /** TIEHALL_SECRET_KEY's box, which opens the App's stored client secret. */
  secrets: () => SecretBox;
  /** GitHub's web pages and API, which a test points at the GitHub stub; github.com and api.github.com otherwise. */
  github?: { webUrl?: string; apiUrl?: string; fetch?: typeof fetch };
  logger?: Logger;
}

export interface SignInService {
  /** Answers a request under /api/auth, such as GitHub's return to the sign-in callback. */
  handler(request: Request): Promise<Response>;
  /** The sign-in page: GET shows it; POST, from a form of the install, sends the browser to GitHub to sign in. */
  page(request: Request): Promise<Response>;
  /**
   * The web session a request's cookie names, or undefined when it names
   * none. A session that a removal ended is refused with 403 removed-member.
   */
  session(headers: Headers): Promise<WebSessionCaller | undefined>;
}

/** The stored credentials a built instance serves with, as a key that changes whenever they do. */
interface StoredCredentials {
  orgId: string;
  clientId: string;
  key: string;
}

type Auth = ReturnType<typeof betterAuth>;

export function createSignInService(options: SignInServiceOptions): SignInService {
  const logger = (options.logger ?? createLogger()).child({ service: "sign-in" });
  const webUrl = options.github?.webUrl ?? GITHUB_WEB_URL;
  const apiUrl = options.github?.apiUrl ?? GITHUB_API_URL;
  const githubFetch = options.github?.fetch ?? createGitHubFetch(fetch);
  const secure = options.url.startsWith("https:");
  /** The session cookie's name, which Better Auth prefixes with __Secure- over HTTPS. */
  const sessionCookie = `${secure ? "__Secure-" : ""}tiehall.session_token`;
  let built: { key: string; auth: Auth } | undefined;

  /** Which credentials are stored now: one small read per request, so a change reaches the next request. */
  async function storedCredentials(): Promise<StoredCredentials | undefined> {
    const [row] = await options.database
      .select({ orgId: orgs.id, clientId: githubApp.clientId, secretUpdatedAt: integrationSecrets.updatedAt, keyId: integrationSecrets.keyId })
      .from(orgs)
      .innerJoin(githubApp, eq(githubApp.orgId, orgs.id))
      .innerJoin(integrationSecrets, and(eq(integrationSecrets.orgId, orgs.id), eq(integrationSecrets.name, "github_app.client_secret")))
      .limit(1);
    if (row === undefined) return undefined;
    return { orgId: row.orgId, clientId: row.clientId, key: `${row.clientId}:${row.keyId}:${row.secretUpdatedAt.toISOString()}` };
  }

  /** The instance built from the stored credentials, built again when they change; undefined while no App is stored. */
  async function current(): Promise<Auth | undefined> {
    const stored = await storedCredentials();
    if (stored === undefined) return undefined;
    if (built?.key === stored.key) return built.auth;
    const clientSecret = await options.database.transaction((tx) => readSecret({ tx, orgId: stored.orgId }, options.secrets(), "github_app.client_secret"));
    if (clientSecret === undefined) return undefined;
    const auth = betterAuth(authOptions({ orgId: stored.orgId, clientId: stored.clientId, clientSecret }));
    built = { key: stored.key, auth };
    logger.info("sign-in service: the sign-in service is built from the GitHub App's stored credentials", { clientId: stored.clientId });
    return auth;
  }

  /** Whether this user may sign in: for now, whether they are a member of the install. */
  async function admits(githubAccountId: number): Promise<boolean> {
    const [row] = await options.database
      .select({ role: members.role })
      .from(users)
      .innerJoin(members, and(eq(members.orgId, users.orgId), eq(members.userId, users.id)))
      .where(eq(users.githubAccountId, githubAccountId));
    return row !== undefined;
  }

  function authOptions(input: { orgId: string; clientId: string; clientSecret: string }): BetterAuthOptions {
    const orgId = { type: "string", required: true, input: false, returned: false, defaultValue: () => input.orgId } as const;
    return {
      appName: "Tiehall",
      baseURL: options.url,
      basePath: AUTH_BASE_PATH,
      secret: options.secret(),
      trustedOrigins: [options.url],
      telemetry: { enabled: false },
      logger: {
        log(level, message, ...args) {
          const error = args.find((arg): arg is Error => arg instanceof Error);
          const line = `sign-in service: ${message}`;
          if (level === "error") logger.error(line, error === undefined ? {} : { error });
          else if (level === "warn") logger.warn(line, error === undefined ? {} : { error });
          else if (level !== "debug") logger.info(line);
        },
      },
      database: drizzleAdapter(options.database, {
        provider: "pg",
        schema: { users, webSessions, signInAccounts, signInVerifications },
      }),
      advanced: {
        cookiePrefix: "tiehall",
        useSecureCookies: secure,
        database: { generateId: "uuid" },
        // The client address the trusted proxies yield: the web role's request guard puts it, alone, in X-Forwarded-For.
        ipAddress: { ipAddressHeaders: ["x-forwarded-for"], ipv6Subnet: 128 },
      },
      onAPIError: { errorURL: `${options.url}${SIGN_IN_PATH}` },
      emailAndPassword: { enabled: false },
      user: {
        modelName: "users",
        fields: { name: "githubLogin", email: "signInKey", emailVerified: "emailVerified", createdAt: "createdAt", updatedAt: "updatedAt" },
        additionalFields: {
          orgId,
          githubAccountId: { type: "number", required: true },
          primaryEmail: { type: "string", required: false, fieldName: "email" },
        },
        async validateUserInfo(data) {
          const githubAccountId = Number((data.user as { githubAccountId?: unknown }).githubAccountId);
          if (Number.isSafeInteger(githubAccountId) && data.source.action !== "link-account" && (await admits(githubAccountId))) return;
          return { error: REFUSED_CODE, errorDescription: SIGN_IN_REFUSED };
        },
      },
      session: {
        modelName: "webSessions",
        additionalFields: { orgId, endedAt: { type: "date", required: false, input: false } },
      },
      account: {
        modelName: "signInAccounts",
        additionalFields: { orgId },
        accountLinking: { enabled: false },
        updateAccountOnSignIn: true,
      },
      verification: { modelName: "signInVerifications", additionalFields: { orgId } },
      databaseHooks: {
        account: {
          create: { before: async () => ({ data: NO_USER_TOKEN }) },
          update: { before: async () => ({ data: NO_USER_TOKEN }) },
        },
      },
      socialProviders: {
        github: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          redirectURI: `${options.url}${SIGN_IN_CALLBACK_PATH}`,
          // A GitHub App ignores OAuth scopes: its permissions decide what a user token may do.
          disableDefaultScope: true,
          overrideUserInfoOnSignIn: true,
          getUserInfo: (tokens) => githubUser(tokens.accessToken),
        },
      },
      plugins: [githubEndpoints()],
      hooks: { before: routeGuard },
    };
  }

  /**
   * Who signed in, from GitHub, with the user token of the sign-in, which is
   * used for this and nothing else: the account's numeric id and login, and
   * its primary verified email address, if it has one.
   */
  async function githubUser(accessToken: string | undefined) {
    if (accessToken === undefined) return null;
    const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "tiehall", "x-github-api-version": "2022-11-28" };
    const profileAnswer = await githubFetch(`${apiUrl}/user`, { headers });
    if (!profileAnswer.ok) {
      logger.warn("sign-in service: GitHub did not say who signed in", { status: profileAnswer.status });
      return null;
    }
    const profileJson: unknown = await profileAnswer.json();
    const profile = GITHUB_USER.safeParse(profileJson);
    if (!profile.success) return null;
    const emailsAnswer = await githubFetch(`${apiUrl}/user/emails`, { headers });
    const emails = emailsAnswer.ok ? GITHUB_EMAILS.safeParse(await emailsAnswer.json()) : undefined;
    const primary = emails?.success === true ? emails.data.find((email) => email.primary && email.verified)?.email : undefined;
    const { id, login } = profile.data;
    return {
      // The account itself is identified by the profile's id (Better Auth's GitHub provider's account subject).
      user: {
        name: login,
        email: `github:${id}`,
        emailVerified: true,
        githubAccountId: id,
        primaryEmail: primary ?? null,
      },
      data: profileJson as GithubProfile,
    };
  }

  /**
   * Points Better Auth's GitHub provider at GitHub's authorize page and token
   * endpoint as this service knows them, github.com or the stub of a test, and
   * makes the code exchange through the service's fetch, which reaches GitHub
   * only.
   */
  function githubEndpoints(): BetterAuthPlugin {
    return {
      id: "tiehall-github-endpoints",
      init(context) {
        const socialProviders = context.socialProviders.map((provider) => {
          if (provider.id !== "github") return provider;
          return {
            ...provider,
            async createAuthorizationURL(input: Parameters<typeof provider.createAuthorizationURL>[0]) {
              const url = await provider.createAuthorizationURL(input);
              return new URL(`${webUrl}${url.pathname}${url.search}`);
            },
            async validateAuthorizationCode(input: { code: string; codeVerifier?: string; redirectURI: string }) {
              const { body, headers } = await authorizationCodeRequest({ ...input, options: provider.options ?? {} });
              const answer = await githubFetch(`${webUrl}/login/oauth/access_token`, { method: "POST", body, headers });
              if (!answer.ok) return null;
              const data = (await answer.json()) as Record<string, unknown>;
              // GitHub answers a refused exchange with 200 and an error in the body.
              if (typeof data["error"] === "string" || typeof data["access_token"] !== "string") {
                logger.warn("sign-in service: GitHub refused the sign-in's code exchange", { reason: typeof data["error"] === "string" ? data["error"] : "no token" });
                return null;
              }
              return getOAuth2Tokens(data);
            },
          };
        }) as typeof context.socialProviders;
        return { context: { socialProviders } };
      },
    };
  }

  function pageResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
  }

  function problem({ status, headers, body }: HttpProblem, extra: Headers = new Headers()): Response {
    const answer = new Headers(headers);
    for (const cookie of extra.getSetCookie()) answer.append("set-cookie", cookie);
    return new Response(JSON.stringify(body), { status, headers: answer });
  }

  return {
    async handler(request) {
      try {
        const auth = await current();
        if (auth === undefined) return problem(httpProblem(new Refusal("route-not-found", "There is no sign-in without the install's GitHub App.")));
        const answer = await auth.handler(request);
        // A refusal of the guard, or a route Better Auth does not have: the error model's 404.
        if (answer.status === 404) return problem(httpProblem(new Refusal("route-not-found", "The install serves no such sign-in route.")));
        const refused = refusalOf(answer);
        if (refused) return problem(httpProblem(new Refusal("sign-in-refused", SIGN_IN_REFUSED)), answer.headers);
        return answer;
      } catch (error) {
        logger.error("sign-in service: a request to the sign-in service failed", { error });
        return problem(internalErrorProblem());
      }
    },

    async page(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" || request.method === "HEAD") {
          const back = returnPath(url.searchParams.get("return"));
          const error = url.searchParams.get("error");
          return pageResponse(signInPage(back, error), 200, {
            // The form posts here, and its answer sends the browser on to GitHub's authorize page.
            "content-security-policy": PAGE_HEADERS["content-security-policy"].replace("form-action 'self'", `form-action 'self' ${new URL(webUrl).origin}`),
          });
        }
        if (request.method !== "POST") return problem(httpProblem(new Refusal("route-not-found", "There is no such page here.")));
        if (originOf(request.headers.get("origin")) !== options.url) {
          return problem(httpProblem(new Refusal("forbidden", "A sign-in starts only from the sign-in page on the install's own URL, TIEHALL_URL.")));
        }
        const auth = await current();
        if (auth === undefined) return problem(httpProblem(new Refusal("setup-required", "Setup is not complete.")));
        const back = returnPath(new URLSearchParams(await request.text()).get("return"));
        const started = await auth.api.signInSocial({
          body: { provider: "github", callbackURL: back, errorCallbackURL: SIGN_IN_PATH },
          headers: request.headers,
          returnHeaders: true,
        });
        const target = started.response.url;
        if (typeof target !== "string") throw new Error("the sign-in service gave no URL of GitHub's authorize page");
        const answer = new Headers({ location: target, "cache-control": "no-store" });
        for (const cookie of started.headers.getSetCookie()) answer.append("set-cookie", cookie);
        return new Response(null, { status: 303, headers: answer });
      } catch (error) {
        if (error instanceof Refusal) return problem(httpProblem(error));
        logger.error("sign-in service: the sign-in page failed", { error });
        return problem(internalErrorProblem());
      }
    },

    async session(headers) {
      if (!cookieNames(headers).includes(sessionCookie)) return undefined;
      const auth = await current();
      if (auth === undefined) return undefined;
      const found = await auth.api.getSession({ headers, query: { disableRefresh: true, disableCookieCache: true } });
      if (found === null) return undefined;
      const session = found.session as typeof found.session & { endedAt?: Date | null };
      if (session.endedAt !== undefined && session.endedAt !== null) throw new RemovedMemberError();
      return { kind: "web_session", userId: session.userId, sessionId: session.id };
    },
  };
}

/**
 * The route guard (design.md, Technical decisions: T8): over HTTP, only the
 * routes on the allowlist are served, and every other one answers 404. A call
 * Tiehall makes itself, in the same process, carries no request and passes.
 */
const routeGuard = createAuthMiddleware(async (context) => {
  if (context.request === undefined) return;
  const allowed = HTTP_ALLOWLIST.get(`${context.request.method.toUpperCase()} ${context.path}`);
  const params = (context.params ?? {}) as Record<string, unknown>;
  if (allowed !== undefined && Object.entries(allowed).every(([name, value]) => params[name] === value)) return;
  throw new APIError("NOT_FOUND", { code: "route_not_found", message: "The install serves no such sign-in route." });
});

/** Whether an answer of the sign-in callback is the redirect Better Auth makes for a refused sign-in. */
function refusalOf(answer: Response): boolean {
  if (answer.status < 300 || answer.status >= 400) return false;
  const location = answer.headers.get("location");
  if (location === null) return false;
  try {
    return new URL(location, "https://tiehall.invalid").searchParams.get("error") === REFUSED_CODE;
  } catch {
    return false;
  }
}

const GITHUB_USER = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
const GITHUB_EMAILS = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

/** The page to return to after signing in: a path of the install, never another site; the home page by default. */
function returnPath(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const parsed = new URL(value, "https://tiehall.invalid");
    return parsed.origin === "https://tiehall.invalid" ? `${parsed.pathname}${parsed.search}` : "/";
  } catch {
    return "/";
  }
}

/** The origin an Origin header names, in the form TIEHALL_URL is kept in; undefined for none. */
function originOf(value: string | null): string | undefined {
  if (value === null || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function cookieNames(headers: Headers): string[] {
  return (headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim().split("=")[0] ?? "")
    .filter((name) => name !== "");
}

/** Why a sign-in did not complete, from the error Better Auth returned to the sign-in page with. */
const ERROR_TEXTS: Readonly<Record<string, string>> = {
  access_denied: "GitHub says you did not authorize the install's GitHub App, so you are not signed in.",
  state_mismatch: "This sign-in did not start in this browser, or it took longer than 10 minutes. Sign in again.",
  state_not_found: "This sign-in did not start in this browser, or it took longer than 10 minutes. Sign in again.",
  please_restart_the_process: "This sign-in did not start in this browser, or it took longer than 10 minutes. Sign in again.",
};

function signInPage(back: string, error: string | null): string {
  const notice =
    error === null
      ? ""
      : `      <p>${escapeHtml(ERROR_TEXTS[error] ?? "The sign-in with GitHub did not complete. Sign in again; if it fails again, tell an admin of the install.")}</p>\n`;
  return htmlPage(
    "Sign in to Tiehall",
    `      <h1>Sign in to Tiehall</h1>
${notice}      <p>${escapeHtml("You sign in with your GitHub account, through this install's own GitHub App.")}</p>
      <form method="post" action="${SIGN_IN_PATH}">
        <input type="hidden" name="return" value="${escapeHtml(back)}">
        <button type="submit">Sign in with GitHub</button>
      </form>`,
  );
}
