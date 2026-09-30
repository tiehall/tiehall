import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";
import type { GithubProfile } from "better-auth/social-providers";
import { and, eq } from "drizzle-orm";
import { isIP } from "node:net";
import { SCOPES } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, signInCompleted, signInRefused, type HttpProblem } from "@tiehall/core";
import {
  githubApp,
  integrationSecrets,
  members,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthDeviceCodes,
  oauthRefreshTokens,
  oauthResources,
  oauthSigningKeys,
  orgs,
  signInAccounts,
  signInRefusals,
  signInVerifications,
  users,
  webSessions,
  type Database,
} from "@tiehall/db";
import type { SigningKeys } from "./agent-tokens.ts";
import { clientRegistrations, REGISTRATION_LIMIT_CODE } from "./agent-clients.ts";
import { grantChecks } from "./agent-grants.ts";
import { continuePathOf, isAuthorizationRequest } from "./consent.ts";
import { AUTHORIZATION_ENDPOINT_PATH, authorizationServerPlugins, mcpResourceOf, REFRESH_SCOPE, type AgentClientOptions } from "./authorization-server.ts";
import { cliDeviceFlow, seedCliClient } from "./device-flow.ts";
import type { WebSessionCaller } from "./caller.ts";
import { GITHUB_API_URL, GITHUB_REQUEST_TIMEOUT_MS, readSignedInUser } from "./github-client.ts";
import { SETUP_SIGN_IN_CALLBACK_PATH, SETUP_SIGN_IN_PATH, SIGN_IN_CALLBACK_PATH } from "./github-manifest.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, TO_SIGN_IN, type WayOn } from "./html.ts";
import { readSecret } from "./integration-secrets.ts";
import { createInstallGitHub } from "./install-github.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { createGitHubFetch } from "./outbound.ts";
import type { SecretBox } from "./secret-box.ts";
import { isSetupSession } from "./setup-code.ts";
import { AdmissionWithdrawnError, applyAdmission, decideAdmission, isMemberNow, type Admission } from "./sign-in-admission.ts";
import { completeSetup, SetupCompletionError } from "./setup-completion.ts";
import { SETUP_PATH } from "./setup-gate.ts";
import { GITHUB_WEB_URL } from "./setup-github.ts";
import { setupCookieName } from "./setup-route.ts";
import { routeInventory, servedOverHttp, servedOverHttpAt } from "./sign-in-routes.ts";
import { RemovedMemberError } from "./with-org.ts";
import { assertWebWrite } from "./web-writes.ts";
import { write, type Origin, type Store, type Writer } from "./write.ts";

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
// every route that the committed classification (sign-in-routes.ts) does not
// mark as harmless: over HTTP the service answers only GitHub's return to the
// sign-in callback and the routes agent clients run the OAuth flow through.
// A path the guard does not serve gets its 404 before the service reads the
// request at all. The sign-in page and sign-out are Tiehall's own pages,
// which call the service in the same process.
//
// The service is also the install's OAuth 2.1 authorization server for agent
// clients (agent-access: Tiehall is the authorization server for agent
// clients; authorization-server.ts): the person who approves an agent client
// is the one signed in to the web UI with GitHub. It serves the discovery
// documents under /.well-known, and the public keys its access tokens are
// signed with, which the check of those tokens reads in this process
// (agent-tokens.ts). The instance that completes setup is no authorization
// server.
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
// The security events of sign-ins (activity-log: Writes the sign-in service
// owns are still recorded; activity-log: Which actions are security events;
// design.md, Technical decisions: T8): the service stores a web session
// itself, so an after-hook appends the sign-in's event right after that
// write. A refused sign-in stores nothing of the service's; Tiehall records
// the refused GitHub account itself, with the refusal's event, which names
// that record. Each keeps the client's address, the one the trusted proxies
// yield, and user agent in the side table, apart from the event.
//
// Who may sign in (sign-in: Who may sign in; sign-in: New members join as
// members): every sign-in is decided before the service writes anything
// (sign-in-admission.ts), and a refused one gets 403 sign-in-refused, telling
// the person to ask an admin for an invite, and creates no session, no user
// and no membership. A person is admitted when their user is already a member
// of the install, when they hold a valid invite, or when GitHub reports them a
// member of the organization of an installation an admin connected. A person
// who is not a member yet joins just before their web session is stored,
// once the service has stored their user, in one transaction with the join's
// security event. A join that no longer holds by then, such as one whose
// invite an admin revoked while GitHub answered, is refused like any other
// refused sign-in. It stores no session, the user it created goes with its
// link to the GitHub account, and the refusal is recorded with its security
// event.
//
// How long a web session lasts (sign-in: Signing out and ending sessions;
// github-layer-hardening: design.md, Decisions this change rests on: D50 (6);
// design.md, Technical decisions: T4): the service expires a session 7 days
// after it was created or last extended, and a read of the session that is
// allowed to renew it extends it to 7 days after the read once a day or more
// has passed since then, with a cookie that renews the browser's. A route
// handler or a server action passes a Headers to session() and carries the
// cookies it collects on its answer; a server component, which cannot set a
// cookie, passes none, and its read renews nothing. Whatever its uses, a
// session ends 30 days after the sign-in that created it: session() deletes
// it then and reads it as none, so the browser is sent to sign in, which runs
// the checks of who may sign in again, rather than refused as a removed
// member's, which is what an ended session means. The library has no such cap,
// so it is Tiehall's own check. The session the setup screen's sign-in creates
// follows the same rules. The authorization endpoint of agent clients, which
// the library serves with its own read of the session, takes a session only
// as session() does: one session() reads as none reaches it as no session, so
// the browser is sent to sign in, and one a removal ended gets 403 there too.
//
// The rate limit (design.md, Technical decisions: T7): the service's own
// limiter is on in every environment, with the library's window and limits,
// in this process's memory, which one web process per install needs; it is
// keyed on the client address the web role's request guard puts, alone, in
// X-Forwarded-For, which a client that is not a trusted proxy cannot set. A
// call over the limit gets the error model's 429 with Retry-After.
//
// The sign-in that completes setup (self-host-install: Setup names the company
// and makes the first admin; sign-in: Who may sign in): while setup is
// incomplete, the setup gate serves only /setup and what lies under it, so the
// setup screen signs the operator in through a second instance of the service
// that lives under /setup/sign-in, whose GitHub callback, TIEHALL_URL
// /setup/sign-in/callback/github, the App's manifest registers beside the
// usual one. It admits a person only from a browser that holds a setup session
// while setup is incomplete, and, before it stores their web session, it
// completes setup with them as the first admin (setup-completion.ts): a
// completion that fails stores no session, and the operator is sent back to
// the setup screen, which says why; the user that sign-in created, if it
// created one, goes with its link to the GitHub account, as for any refused
// sign-in, and a user that existed before stays. Once setup is complete,
// /setup answers 404 and that instance is never reached again.

/** Where the sign-in service's own routes live, such as GitHub's return to the sign-in callback. */
export const AUTH_BASE_PATH = "/api/auth";
/** The sign-in page: GET shows it, POST starts a sign-in with GitHub. */
export const SIGN_IN_PATH = "/sign-in";
/** Where the web UI's sign-out form posts. */
export const SIGN_OUT_PATH = "/sign-out";

/** Where a refused sign-out leads a browser on: back to the home page, whose form it posted. */
const TO_HOME: WayOn = { href: "/", text: "Back to Tiehall's home page" };
/** Where a refusal of the setup screen's sign-in leads a browser on: back to the setup screen. */
const TO_SETUP: WayOn = { href: SETUP_PATH, text: "Back to the setup screen" };

/** What a refused person reads. */
export const SIGN_IN_REFUSED =
  "Your GitHub account may not sign in to this install. Ask an admin of the install for an invite, then sign in again.";

/** What a sign-in from the setup screen without a setup session reads. */
export const SETUP_SIGN_IN_REFUSED =
  "Setup is completed only by a sign-in from the browser that entered the setup code, while setup is not complete. Open the setup screen in that browser.";

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

/** How many days a web session lasts after it was created or last extended, when it is not used. */
export const SESSION_IDLE_DAYS = 7;
/** How many days must pass since a web session was created or last extended before a use extends it again. */
export const SESSION_UPDATE_AGE_DAYS = 1;
/** How many days after the sign-in that created it a web session ends at the latest, however often it is used. */
export const SESSION_LIFETIME_DAYS = 30;

const DAY_SECONDS = 24 * 60 * 60;

/** The sign-in service's rate limit: at most this many calls to one route from one client address in each window. */
export const RATE_LIMIT_MAX = 100;
/** The window of the sign-in service's rate limit, in seconds. */
export const RATE_LIMIT_WINDOW_SECONDS = 10;

export interface SignInServiceOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's URL (TIEHALL_URL), as its origin. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the service's cookies; read when the service is first built. */
  secret: () => string;
  /** TIEHALL_SECRET_KEY's box, which opens the App's stored client secret. */
  secrets: () => SecretBox;
  /**
   * GitHub's web pages and API, which a test points at the GitHub stub; github.com and api.github.com otherwise,
   * and how long one request waits for GitHub, GITHUB_REQUEST_TIMEOUT_MS unless a test gives another.
   */
  github?: { webUrl?: string; apiUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
  /** Where the sign-in that completes setup sends the jobs of the deliveries held during setup; without it, a job that runs every minute releases them. */
  jobs?: JobSender;
  /** How the service's authorization server takes agent clients, such as whether it fetches their metadata documents. */
  agentClients?: AgentClientOptions;
  logger?: Logger;
}

/**
 * The sign-in that completes setup, which the setup screen offers to a browser
 * that holds a setup session, once it has checked that session and the form's
 * origin.
 */
export interface SetupSignIn {
  /** Starts a sign-in with GitHub from the setup screen: sends the browser to GitHub's authorize page. */
  start(request: Request): Promise<Response>;
  /** GitHub's return to the setup screen's sign-in callback, which completes setup and signs the first admin in. */
  callback(request: Request): Promise<Response>;
}

export interface SignInService {
  /** Answers a request under /api/auth, such as GitHub's return to the sign-in callback. */
  handler(request: Request): Promise<Response>;
  /** The sign-in page: GET shows it; POST, from a form of the install, sends the browser to GitHub to sign in. */
  page(request: Request): Promise<Response>;
  /**
   * The web UI's sign-out: a POST that passes the web UI's write checks ends
   * the web session its cookie names, that one only, and leads to the sign-in
   * page.
   */
  signOut(request: Request): Promise<Response>;
  /**
   * The web session a request's cookie names, or undefined when it names
   * none, has expired or has reached its 30 days, which deletes it. A session
   * that a removal ended, or whose user is not a member of the install, is
   * refused with 403 removed-member. Given `renewal`, as a route handler or a
   * server action gives it, the read extends a session due for it and adds
   * there the Set-Cookie values that renew the browser's cookie, or expire
   * it for a session that is gone, which the caller's answer carries; without
   * it, as for a server component, the read renews nothing.
   */
  session(headers: Headers, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** Every route of the service as it is built now, such as `GET /callback/:id`, for the route inventory test. */
  routes(): Promise<string[]>;
  /**
   * The install's public signing keys, which the access tokens of agent
   * clients are signed with, read in this process (agent-tokens.ts);
   * undefined while no App is stored, so no service exists.
   */
  signingKeys(): Promise<SigningKeys | undefined>;
  /** The sign-in that completes setup, under /setup/sign-in. */
  setup: SetupSignIn;
}

/** The two instances of the service: the usual one under /api/auth, and the one that completes setup under /setup/sign-in. */
type Mode = "sign-in" | "setup";

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
  const timeoutMs = options.github?.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const secure = options.url.startsWith("https:");
  /** The session cookie's name, which Better Auth prefixes with __Secure- over HTTPS. */
  const sessionCookie = `${secure ? "__Secure-" : ""}tiehall.session_token`;
  /** The setup session's cookie, which the setup screen sets. */
  const setupCookie = setupCookieName(options.url);
  const built = new Map<Mode, { key: string; auth: Auth }>();
  const installGitHub = createInstallGitHub({
    database: options.database,
    secrets: options.secrets,
    ...(options.github?.apiUrl === undefined ? {} : { apiUrl: options.github.apiUrl }),
    ...(options.github?.fetch === undefined ? {} : { fetch: options.github.fetch }),
    logger,
  });
  // Sign-in events start no job.
  const store: Store = {
    database: options.database,
    jobs: {
      send: () => Promise.reject(new Error("the sign-in service's writes start no job")),
    },
  };

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
  async function current(mode: Mode = "sign-in"): Promise<Auth | undefined> {
    const stored = await storedCredentials();
    if (stored === undefined) return undefined;
    const existing = built.get(mode);
    if (existing?.key === stored.key) return existing.auth;
    const clientSecret = await options.database.transaction((tx) => readSecret({ tx, orgId: stored.orgId }, options.secrets(), "github_app.client_secret"));
    if (clientSecret === undefined) return undefined;
    const auth = betterAuth(authOptions({ orgId: stored.orgId, clientId: stored.clientId, clientSecret }, mode));
    if (mode === "sign-in") {
      // Once the authorization server has made its MCP resource's record, the CLI is seeded as its registered client.
      await auth.$context;
      await seedCliClient(options.database, stored.orgId, { resource: mcpResourceOf(options.url), scopes: [...SCOPES, REFRESH_SCOPE] });
    }
    built.set(mode, { key: stored.key, auth });
    logger.info("sign-in service: the sign-in service is built from the GitHub App's stored credentials", { clientId: stored.clientId, mode });
    return auth;
  }

  /** Whether a sign-in from the setup screen comes from a browser that holds a setup session while setup is incomplete. */
  async function admitsSetup(context: { request?: Request | undefined; headers?: Headers | undefined } | null | undefined): Promise<boolean> {
    const headers = context?.request?.headers ?? context?.headers;
    return isSetupSession(options.database, cookieValue(headers, setupCookie));
  }

  /**
   * The admissions decided for sign-ins in progress, by the GitHub account's
   * numeric id: the check of who may sign in decides before the service
   * writes anything, and the person joins, if they are not a member yet, once
   * the service has stored their user, just before their web session.
   */
  const admissions = new Map<number, Admission>();
  /** The users whose sign-in in progress cleared an admin removal's block, which the sign-in's own security event names. */
  const clearedBlocks = new Set<string>();
  /** The users that sign-ins in progress created, which a sign-in refused before its session is stored does not leave behind. */
  const createdUsers = new Set<string>();
  const admissionServices = { database: options.database, github: installGitHub, logger };

  /** The GitHub account of a user, by its numeric id. */
  async function githubAccountOf(userId: string): Promise<number | undefined> {
    const [row] = await options.database.select({ githubAccountId: users.githubAccountId }).from(users).where(eq(users.id, userId));
    return row?.githubAccountId;
  }

  function authOptions(input: { orgId: string; clientId: string; clientSecret: string }, mode: Mode): BetterAuthOptions {
    const orgId = { type: "string", required: true, input: false, returned: false, defaultValue: () => input.orgId } as const;
    const setup = mode === "setup";
    return {
      appName: "Tiehall",
      baseURL: options.url,
      basePath: setup ? SETUP_SIGN_IN_PATH : AUTH_BASE_PATH,
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
        schema: {
          users,
          webSessions,
          signInAccounts,
          signInVerifications,
          oauthSigningKeys,
          oauthClients,
          oauthResources,
          oauthClientResources,
          oauthRefreshTokens,
          oauthAccessTokens,
          oauthConsents,
          oauthClientAssertions,
          oauthDeviceCodes,
        },
      }),
      advanced: {
        cookiePrefix: "tiehall",
        useSecureCookies: secure,
        database: { generateId: "uuid" },
        // The client address the trusted proxies yield: the web role's request guard puts it, alone, in X-Forwarded-For.
        ipAddress: { ipAddressHeaders: ["x-forwarded-for"], ipv6Subnet: 128 },
      },
      // The service's rate limit, on in every environment, not only in production, as the library would have it:
      // keyed on the client address above, kept in this process's memory (one web process per install), with the
      // library's own window and limits. Over HTTP it serves only GitHub's return to the callback, 100 calls per 10
      // seconds from one address; the next gets the error model's 429 (refusalOfRateLimit).
      rateLimit: { enabled: true, storage: "memory", window: RATE_LIMIT_WINDOW_SECONDS, max: RATE_LIMIT_MAX },
      onAPIError: { errorURL: `${options.url}${setup ? SETUP_PATH : SIGN_IN_PATH}` },
      emailAndPassword: { enabled: false },
      user: {
        modelName: "users",
        fields: { name: "githubLogin", email: "signInKey", emailVerified: "emailVerified", createdAt: "createdAt", updatedAt: "updatedAt" },
        additionalFields: {
          orgId,
          githubAccountId: { type: "number", required: true },
          primaryEmail: { type: "string", required: false, fieldName: "email" },
        },
        async validateUserInfo(data, context) {
          const user = data.user as { id?: unknown; name?: unknown; githubAccountId?: unknown };
          if (setup) {
            if (data.source.action !== "link-account" && (await admitsSetup(context))) return;
            // Nothing is recorded: the activity log takes no event before setup completes.
            logger.warn("sign-in service: a sign-in from the setup screen came without a setup session, or after setup completed");
            return { error: REFUSED_CODE, errorDescription: SETUP_SIGN_IN_REFUSED };
          }
          const githubAccountId = Number(user.githubAccountId);
          const login = typeof user.name === "string" ? user.name : "";
          if (Number.isSafeInteger(githubAccountId) && githubAccountId > 0 && data.source.action !== "link-account") {
            const admission = await decideAdmission(admissionServices, { id: githubAccountId, login });
            if (admission !== undefined) {
              admissions.set(githubAccountId, admission);
              return;
            }
          }
          // A known user, such as a removed member, is named too: the one a sign-in of an existing account would reach.
          const userId = data.source.action === "sign-in" && typeof user.id === "string" ? user.id : undefined;
          try {
            await recordRefusal({ githubAccountId, login, userId }, whereFrom(context));
          } catch (error) {
            // The refusal stands: nobody is signed in, and the log says the event is missing.
            logger.error("sign-in service: the security event of a refused sign-in could not be appended", { error });
          }
          return { error: REFUSED_CODE, errorDescription: SIGN_IN_REFUSED };
        },
      },
      // Both instances store sessions of the same lengths: 7 days from their creation or last extension, extended at
      // most once a day; the 30-day cap is session()'s own.
      session: {
        modelName: "webSessions",
        additionalFields: { orgId, endedAt: { type: "date", required: false, input: false } },
        expiresIn: SESSION_IDLE_DAYS * DAY_SECONDS,
        updateAge: SESSION_UPDATE_AGE_DAYS * DAY_SECONDS,
      },
      account: {
        modelName: "signInAccounts",
        additionalFields: { orgId },
        accountLinking: { enabled: false },
        updateAccountOnSignIn: true,
      },
      verification: { modelName: "signInVerifications", additionalFields: { orgId } },
      databaseHooks: {
        session: {
          create: {
            // The sign-in from the setup screen completes setup before its session is stored, or stores none; any other
            // sign-in makes a person who is not a member yet join, as its admission says, or stores none.
            ...(setup
              ? {
                  async before(session: { userId: string }, context: Parameters<typeof whereFrom>[0]) {
                    const created = createdUsers.delete(session.userId);
                    try {
                      await completeSetup(
                        { database: options.database, github: installGitHub, ...(options.jobs === undefined ? {} : { jobs: options.jobs }), logger },
                        { userId: session.userId, origin: whereFrom(context) },
                      );
                    } catch (error) {
                      // A refused sign-in creates no Tiehall user: the one this sign-in created goes, with its link to the GitHub account.
                      if (created) {
                        try {
                          await forgetCreatedUser(session.userId);
                        } catch (failure) {
                          logger.error("sign-in service: the user a sign-in from the setup screen created could not be removed", { error: failure });
                        }
                      }
                      if (!(error instanceof SetupCompletionError)) throw error;
                      logger.warn("sign-in service: setup could not be completed", { error, reason: error.code });
                      throw new APIError("FORBIDDEN", { code: error.code, message: error.message });
                    }
                  },
                }
              : {
                  async before(session: { userId: string }, context: Parameters<typeof whereFrom>[0]) {
                    const githubAccountId = await githubAccountOf(session.userId);
                    const admission = githubAccountId === undefined ? undefined : admissions.get(githubAccountId);
                    if (githubAccountId !== undefined) admissions.delete(githubAccountId);
                    const created = createdUsers.delete(session.userId);
                    try {
                      if (admission === undefined) throw new AdmissionWithdrawnError();
                      const applied = await applyAdmission({ database: options.database }, { userId: session.userId, admission, origin: whereFrom(context) });
                      if (applied.blockCleared) clearedBlocks.add(session.userId);
                    } catch (error) {
                      if (!(error instanceof AdmissionWithdrawnError)) throw error;
                      logger.warn("sign-in service: a sign-in's admission no longer held when its session was to be stored", { userId: session.userId });
                      try {
                        await refuseWithdrawn(session.userId, { created }, whereFrom(context));
                      } catch (failure) {
                        // The refusal stands: nobody is signed in, and the log says what is missing.
                        logger.error("sign-in service: a sign-in refused before its session was stored could not be recorded", { error: failure });
                      }
                      throw new APIError("FORBIDDEN", { code: REFUSED_CODE, message: SIGN_IN_REFUSED });
                    }
                  },
                }),
            async after(session, context) {
              const blockCleared = clearedBlocks.delete(session.userId);
              // A removal that committed while the session was stored, too early to end it: the session goes, and the sign-in is refused.
              if (!setup && !(await isMemberNow({ database: options.database }, session.userId))) {
                logger.warn("sign-in service: a removal ended the membership while the sign-in's session was stored", { userId: session.userId });
                try {
                  await refuseWithdrawn(session.userId, { created: false, sessionId: session.id }, whereFrom(context));
                } catch (failure) {
                  logger.error("sign-in service: a sign-in refused as its session was stored could not be recorded", { error: failure });
                  await options.database.delete(webSessions).where(eq(webSessions.id, session.id));
                }
                throw new APIError("FORBIDDEN", { code: REFUSED_CODE, message: SIGN_IN_REFUSED });
              }
              await recordSignIn(session.userId, whereFrom(context), blockCleared);
            },
          },
        },
        account: {
          create: { before: async () => ({ data: NO_USER_TOKEN }) },
          update: { before: async () => ({ data: NO_USER_TOKEN }) },
        },
        // A sign-in that creates its person's user, which a refusal before the session is stored then removes, and so
        // does a sign-in from the setup screen that could not complete setup.
        user: { create: { after: async (user: { id: string }) => void createdUsers.add(user.id) } },
      },
      socialProviders: {
        github: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          redirectURI: `${options.url}${setup ? SETUP_SIGN_IN_CALLBACK_PATH : SIGN_IN_CALLBACK_PATH}`,
          // A GitHub App ignores OAuth scopes: its permissions decide what a user token may do.
          disableDefaultScope: true,
          overrideUserInfoOnSignIn: true,
          getUserInfo: (tokens) => githubUser(tokens.accessToken),
        },
      },
      // The usual instance is also the install's authorization server for agent clients (authorization-server.ts);
      // the one that completes setup signs the first admin in and nothing more.
      plugins: [
        githubEndpoints(),
        ...(setup
          ? []
          : [
              ...authorizationServerPlugins({ url: options.url, orgId: input.orgId, ...(options.agentClients === undefined ? {} : { clients: options.agentClients }) }),
              clientRegistrations({ database: options.database, ...(options.agentClients?.now === undefined ? {} : { now: options.agentClients.now }) }),
              cliDeviceFlow({ database: options.database, resource: mcpResourceOf(options.url), refreshScope: REFRESH_SCOPE }),
              grantChecks({ database: options.database }),
            ]),
      ],
      hooks: { before: routeGuard },
    };
  }

  /** Appends the security event of a sign-in whose session the service just stored, naming a block it cleared. */
  async function recordSignIn(userId: string, origin: Origin, blockCleared = false): Promise<void> {
    try {
      await write(
        store,
        { actorKind: "web_session", userId, surface: "web" },
        (writer) => writer.record(signInCompleted, { userId, ...(blockCleared ? { blockCleared: true } : {}) }),
        { origin },
      );
    } catch (error) {
      // The session is stored: the person is signed in, and the log says the event is missing.
      logger.error("sign-in service: the security event of a sign-in could not be appended", { error, userId });
    }
  }

  /** Records the GitHub account a sign-in refused, and appends the refusal's security event, in one write. */
  async function recordRefusal(account: { githubAccountId: number; login: string; userId: string | undefined }, origin: Origin): Promise<void> {
    if (!Number.isSafeInteger(account.githubAccountId) || account.githubAccountId <= 0) return;
    await write(store, { actorKind: "system", surface: "web" }, (writer) => appendRefusal(writer, account), { origin });
  }

  /**
   * Refuses a sign-in whose admission no longer held when its web session was
   * to be stored, or once it was, in one write: the session it stored goes,
   * and so does a user this sign-in created, with its link to the GitHub
   * account, so the refusal leaves no session and no Tiehall user behind; the
   * refused GitHub account is recorded with the refusal's event, which names
   * the user only when it stays.
   */
  async function refuseWithdrawn(userId: string, what: { created: boolean; sessionId?: string }, origin: Origin): Promise<void> {
    const { created, sessionId } = what;
    await write(
      store,
      { actorKind: "system", surface: "web" },
      async (writer) => {
        const [user] = await writer.tx
          .select({ githubAccountId: users.githubAccountId, login: users.githubLogin })
          .from(users)
          .where(and(eq(users.orgId, writer.orgId), eq(users.id, userId)));
        if (user === undefined) throw new Error("the refused sign-in's user is gone");
        if (sessionId !== undefined) await writer.tx.delete(webSessions).where(and(eq(webSessions.orgId, writer.orgId), eq(webSessions.id, sessionId)));
        if (created) {
          await writer.tx.delete(signInAccounts).where(and(eq(signInAccounts.orgId, writer.orgId), eq(signInAccounts.userId, userId)));
          await writer.tx.delete(users).where(and(eq(users.orgId, writer.orgId), eq(users.id, userId)));
        }
        await appendRefusal(writer, { githubAccountId: user.githubAccountId, login: user.login, userId: created ? undefined : userId });
      },
      { origin },
    );
  }

  /**
   * Removes a user that a sign-in from the setup screen created, with its
   * link to the GitHub account, when that sign-in could not complete setup.
   * Setup is not complete, so nothing else refers to the user, and the
   * activity log takes no event before setup completes.
   */
  async function forgetCreatedUser(userId: string): Promise<void> {
    await options.database.transaction(async (tx) => {
      await tx.delete(signInAccounts).where(eq(signInAccounts.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });
  }

  /** Records a refused GitHub account, and appends the refusal's security event, in the writer's transaction. */
  async function appendRefusal(writer: Writer, account: { githubAccountId: number; login: string; userId: string | undefined }): Promise<void> {
    const [refusal] = await writer.tx
      .insert(signInRefusals)
      .values({ orgId: writer.orgId, githubAccountId: account.githubAccountId, githubLogin: account.login })
      .returning({ id: signInRefusals.id });
    await writer.record(signInRefused, { refusalId: refusal!.id, ...(account.userId === undefined ? {} : { userId: account.userId }) });
  }

  /**
   * Who signed in, from GitHub, with the user token of the sign-in, which is
   * used for this and nothing else, through the GitHub client: the account's
   * numeric id and login, and its primary verified email address, if it has
   * one. When GitHub does not give the account's addresses, the user keeps the
   * address it has: the field is left out, so the sign-in does not change it.
   */
  async function githubUser(accessToken: string | undefined) {
    if (accessToken === undefined) return null;
    const signedIn = await readSignedInUser(accessToken, { apiUrl, fetch: githubFetch as typeof fetch, logger, timeoutMs });
    if (signedIn === undefined) return null;
    const { id, login, primaryEmail } = signedIn;
    return {
      // The account itself is identified by the profile's id (Better Auth's GitHub provider's account subject).
      user: {
        name: login,
        email: `github:${id}`,
        emailVerified: true,
        githubAccountId: id,
        ...(primaryEmail === undefined ? {} : { primaryEmail }),
      },
      data: signedIn.profile as unknown as GithubProfile,
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
              let data: Record<string, unknown>;
              try {
                // A bounded wait, like every call to GitHub (github-client.ts): a GitHub that does not answer fails the sign-in.
                const answer = await githubFetch(`${webUrl}/login/oauth/access_token`, {
                  method: "POST",
                  body,
                  headers,
                  signal: AbortSignal.timeout(timeoutMs),
                });
                if (!answer.ok) return null;
                data = (await answer.json()) as Record<string, unknown>;
              } catch (error) {
                logger.warn("sign-in service: GitHub did not answer the sign-in's code exchange", { error });
                return null;
              }
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

  /**
   * A refusal of GitHub's return to the sign-in callback, or of a page's
   * form: a page for a browser, which leads on to the sign-in page or back to
   * the setup screen or the home page, and the problem for every other client
   * (public-api: One error model for Tiehall's own refusals; html.ts).
   */
  function refused(request: Request, refusal: Refusal, wayOn: WayOn, extra: Headers = new Headers()): Response {
    return answerRefusal(request, httpProblem(refusal), wayOn, extra);
  }

  /**
   * The web session a request's cookie names, as every page and route of the
   * install takes it (SignInService.session()).
   */
  async function readSession(headers: Headers, renewal?: Headers): Promise<WebSessionCaller | undefined> {
    if (!cookieNames(headers).includes(sessionCookie)) return undefined;
    const auth = await current();
    if (auth === undefined) return undefined;
    // First a read that renews nothing: an ended session, a capped one or a removed member's is not extended.
    const read = await auth.api.getSession({ headers, query: { disableRefresh: true, disableCookieCache: true }, returnHeaders: true });
    // A session that has expired is gone now, and the service's answer expires the browser's cookie.
    passOn(read.headers, renewal);
    const found = read.response;
    if (found === null) return undefined;
    const session = found.session as typeof found.session & { endedAt?: Date | null };
    if (session.endedAt !== undefined && session.endedAt !== null) throw new RemovedMemberError();
    // 30 days after its sign-in, the session goes, and the browser is sent to sign in again.
    if (Date.now() - new Date(session.createdAt).getTime() >= SESSION_LIFETIME_DAYS * DAY_SECONDS * 1000) {
      await options.database.delete(webSessions).where(eq(webSessions.id, session.id));
      const gone = await auth.api.getSession({ headers, query: { disableRefresh: true, disableCookieCache: true }, returnHeaders: true });
      passOn(gone.headers, renewal);
      return undefined;
    }
    // Only a member's session serves anything, whatever ended or did not end it.
    const [member] = await options.database.select({ userId: members.userId }).from(members).where(eq(members.userId, session.userId)).limit(1);
    if (member === undefined) throw new RemovedMemberError();
    // A day or more after its creation or last extension, a read that may renew it extends it, as the service does.
    if (renewal !== undefined && dueForExtension(new Date(session.expiresAt))) {
      const renewed = await auth.api.getSession({ headers, query: { disableCookieCache: true }, returnHeaders: true });
      passOn(renewed.headers, renewal);
      if (renewed.response === null) return undefined;
    }
    return { kind: "web_session", userId: session.userId, sessionId: session.id };
  }

  return {
    async handler(request) {
      try {
        // GitHub's return to the sign-in callback is a page route; every other route of the service answers problems.
        const answerRefused = (refusal: Refusal, extra?: Headers) =>
          new URL(request.url).pathname === SIGN_IN_CALLBACK_PATH ? refused(request, refusal, TO_SIGN_IN, extra) : problem(httpProblem(refusal), extra);
        const auth = await current();
        if (auth === undefined) return answerRefused(new Refusal("route-not-found", "There is no sign-in without the install's GitHub App."));
        // A route under /api/auth that the guard does not serve over HTTP gets 404 before the service reads the request.
        const { pathname } = new URL(request.url);
        if (pathname.startsWith(`${AUTH_BASE_PATH}/`) && !servedOverHttpAt(request.method, pathname.slice(AUTH_BASE_PATH.length))) {
          return answerRefused(new Refusal("route-not-found", "The install serves no such sign-in route."));
        }
        // The authorization endpoint takes a web session only as the install's pages take it: one that has expired or
        // reached its 30 days is none, so the browser is sent to sign in, and one a removal ended gets 403 and no code.
        let forwarded = request;
        const renewal = new Headers();
        if (pathname === AUTHORIZATION_ENDPOINT_PATH && cookieNames(request.headers).includes(sessionCookie)) {
          let caller: WebSessionCaller | undefined;
          try {
            caller = await readSession(request.headers, renewal);
          } catch (error) {
            if (error instanceof Refusal) return refused(request, error, TO_SIGN_IN, renewal);
            throw error;
          }
          if (caller === undefined) forwarded = new Request(request, { headers: withoutCookie(request.headers, sessionCookie) });
        }
        const answer = await auth.handler(forwarded);
        // A refusal of the guard, or a route Better Auth does not have: the error model's 404.
        if (answer.status === 404) return answerRefused(new Refusal("route-not-found", "The install serves no such sign-in route."));
        if (answer.status === 429) return answerRefused(await refusalOfLimit(answer));
        if (refusalOf(answer)) return answerRefused(new Refusal("sign-in-refused", SIGN_IN_REFUSED), answer.headers);
        return withSetCookies(answer, renewal);
      } catch (error) {
        logger.error("sign-in service: a request to the sign-in service failed", { error });
        return problem(internalErrorProblem());
      }
    },

    async page(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" || request.method === "HEAD") {
          // An agent client's authorization that reached the sign-in page goes on once the person has signed in.
          const back = isAuthorizationRequest(url.searchParams) ? continuePathOf(url.searchParams) : returnPath(url.searchParams.get("return"));
          const error = url.searchParams.get("error");
          return pageResponse(signInPage(back, error), 200, {
            // The form posts here, and its answer sends the browser on to GitHub's authorize page.
            "content-security-policy": PAGE_HEADERS["content-security-policy"].replace("form-action 'self'", `form-action 'self' ${new URL(webUrl).origin}`),
          });
        }
        if (request.method !== "POST") return refused(request, new Refusal("route-not-found", "There is no such page here."), TO_SIGN_IN);
        if (originOf(request.headers.get("origin")) !== options.url) {
          return refused(request, new Refusal("forbidden", "A sign-in starts only from the sign-in page on the install's own URL, TIEHALL_URL."), TO_SIGN_IN);
        }
        const auth = await current();
        if (auth === undefined) return refused(request, new Refusal("setup-required", "Setup is not complete."), TO_SIGN_IN);
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
        if (error instanceof Refusal) return refused(request, error, TO_SIGN_IN);
        logger.error("sign-in service: the sign-in page failed", { error });
        return problem(internalErrorProblem());
      }
    },

    async signOut(request) {
      try {
        if (request.method !== "POST") return refused(request, new Refusal("route-not-found", "Sign out with the sign-out button of a page."), TO_HOME);
        const toSignIn = new Headers({ location: SIGN_IN_PATH, "cache-control": "no-store" });
        const session = cookieNames(request.headers).includes(sessionCookie) ? await readSession(request.headers).catch(() => undefined) : undefined;
        const auth = await current();
        if (session === undefined || auth === undefined) return new Response(null, { status: 303, headers: toSignIn });
        const form = new URLSearchParams(await request.text());
        assertWebWrite(
          { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
          { url: options.url, secret: options.secret(), sessionId: session.sessionId, confirm: false },
        );
        // In the same process: the service deletes the session, and its answer expires the browser's cookie.
        const ended = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
        for (const cookie of ended.headers.getSetCookie()) toSignIn.append("set-cookie", cookie);
        return new Response(null, { status: 303, headers: toSignIn });
      } catch (error) {
        if (error instanceof Refusal) return refused(request, error, TO_HOME);
        logger.error("sign-in service: a sign-out failed", { error });
        return problem(internalErrorProblem());
      }
    },

    async routes() {
      const auth = await current();
      return auth === undefined ? [] : routeInventory(auth.api);
    },

    async signingKeys() {
      const auth = await current();
      if (auth === undefined) return undefined;
      // The public keys only, as the JWKS endpoint serves them, read from the database in this process.
      return (await (auth.api as unknown as { getJwks(): Promise<SigningKeys> }).getJwks());
    },

    setup: {
      async start(request) {
        try {
          const auth = await current("setup");
          if (auth === undefined) return refused(request, new Refusal("conflict", "Create the install's GitHub App first: sign-in goes through it."), TO_SETUP);
          const started = await auth.api.signInSocial({
            body: { provider: "github", callbackURL: "/", errorCallbackURL: SETUP_PATH },
            headers: request.headers,
            returnHeaders: true,
          });
          const target = started.response.url;
          if (typeof target !== "string") throw new Error("the sign-in service gave no URL of GitHub's authorize page");
          const answer = new Headers({ location: target, "cache-control": "no-store" });
          for (const cookie of started.headers.getSetCookie()) answer.append("set-cookie", cookie);
          return new Response(null, { status: 303, headers: answer });
        } catch (error) {
          if (error instanceof Refusal) return refused(request, error, TO_SETUP);
          logger.error("sign-in service: a sign-in from the setup screen could not start", { error });
          return problem(internalErrorProblem());
        }
      },

      async callback(request) {
        try {
          const auth = await current("setup");
          if (auth === undefined) return refused(request, new Refusal("route-not-found", "There is no sign-in without the install's GitHub App."), TO_SETUP);
          const answer = await auth.handler(request);
          if (answer.status === 404) return refused(request, new Refusal("route-not-found", "The install serves no such sign-in route."), TO_SETUP);
          if (answer.status === 429) return refused(request, refusalOfRateLimit(answer), TO_SETUP);
          if (refusalOf(answer)) return refused(request, new Refusal("forbidden", SETUP_SIGN_IN_REFUSED), TO_SETUP, answer.headers);
          return answer;
        } catch (error) {
          logger.error("sign-in service: GitHub's return to the setup screen's sign-in failed", { error });
          return problem(internalErrorProblem());
        }
      },
    },

    session: readSession,
  };
}

/**
 * Whether a session that expires then is due to be extended by a use now: a
 * day or more has passed since it was created or last extended, which set its
 * expiry 7 days after that, by the service's own rule.
 */
function dueForExtension(expiresAt: Date): boolean {
  return expiresAt.getTime() - (SESSION_IDLE_DAYS - SESSION_UPDATE_AGE_DAYS) * DAY_SECONDS * 1000 <= Date.now();
}

/** Adds the Set-Cookie values of the service's answer to the ones a route handler or a server action carries on. */
function passOn(answer: Headers, renewal: Headers | undefined): void {
  if (renewal === undefined) return;
  for (const cookie of answer.getSetCookie()) renewal.append("set-cookie", cookie);
}

/**
 * The route guard (design.md, Technical decisions: T8): over HTTP, only the
 * routes the committed classification marks as harmless are served
 * (sign-in-routes.ts), and every other one answers 404. A call Tiehall makes
 * itself, in the same process, carries no request and passes.
 */
const routeGuard = createAuthMiddleware(async (context) => {
  if (context.request === undefined) return;
  if (servedOverHttp(context.request.method, context.path, (context.params ?? {}) as Record<string, unknown>)) return;
  throw new APIError("NOT_FOUND", { code: "route_not_found", message: "The install serves no such sign-in route." });
});

/**
 * The error model's 429 for a call the service refused for a limit: the
 * registrations of agent clients from one address, 10 an hour, with the
 * seconds until the oldest leaves the hour; the fetches of Client ID Metadata
 * Documents from the host a client's id names, 60 a minute, whose count
 * clears within the minute; or the service's own rate limit, with the seconds
 * to wait that its answer names.
 */
async function refusalOfLimit(answer: Response): Promise<Refusal> {
  const body = (await answer
    .clone()
    .json()
    .catch(() => undefined)) as { error?: unknown; code?: unknown; message?: unknown } | undefined;
  if (body?.code === REGISTRATION_LIMIT_CODE) {
    const retryAfterSeconds = Number(answer.headers.get("x-retry-after"));
    return new Refusal("rate-limited", typeof body.message === "string" ? body.message : "This address registered as many agent clients this hour as it may.", {
      retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 3600,
    });
  }
  if (body?.error === "temporarily_unavailable") {
    return new Refusal(
      "rate-limited",
      "Tiehall fetched as many client metadata documents from this client's host as it does in a minute. Try again in a minute.",
      { retryAfterSeconds: 60 },
    );
  }
  return refusalOfRateLimit(answer);
}

/**
 * The error model's 429 for a call the sign-in service's rate limit refused,
 * with the seconds to wait that the library's answer names.
 */
function refusalOfRateLimit(answer: Response): Refusal {
  const named = Number(answer.headers.get("x-retry-after"));
  const retryAfterSeconds = Number.isSafeInteger(named) && named > 0 ? named : RATE_LIMIT_WINDOW_SECONDS;
  return new Refusal("rate-limited", "Too many sign-in calls came from this address. Wait, then sign in again.", { retryAfterSeconds });
}

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

/**
 * Where a sign-in came from: the client's address, which the web role's
 * request guard puts, alone, in X-Forwarded-For from what the trusted proxies
 * yield, and its user agent.
 */
function whereFrom(context: { request?: Request | undefined; headers?: Headers | undefined } | null | undefined): Origin {
  const headers = context?.request?.headers ?? context?.headers;
  const address = headers?.get("x-forwarded-for")?.trim();
  const userAgent = headers?.get("user-agent") ?? undefined;
  return {
    ...(address !== undefined && isIP(address) !== 0 ? { ipAddress: address } : {}),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
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

/** A cookie's value from a Cookie header, or undefined when it carries none by that name. */
function cookieValue(headers: Headers | undefined, name: string): string | undefined {
  for (const pair of (headers?.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The headers without one cookie, so the service reads the request as if the browser had not sent it. */
function withoutCookie(headers: Headers, name: string): Headers {
  const kept = new Headers(headers);
  const cookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && (pair.split("=")[0] ?? "") !== name);
  if (cookies.length === 0) kept.delete("cookie");
  else kept.set("cookie", cookies.join("; "));
  return kept;
}

/** The answer with the Set-Cookie values a read of the session gave, such as one that expires an ended session's cookie. */
function withSetCookies(answer: Response, cookies: Headers): Response {
  const set = cookies.getSetCookie();
  if (set.length === 0) return answer;
  const headers = new Headers(answer.headers);
  for (const cookie of set) headers.append("set-cookie", cookie);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
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
