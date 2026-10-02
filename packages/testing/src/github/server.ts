import { createHash, randomUUID } from "node:crypto";
import { looksLikeJwt, verifyAppJwt } from "./jwt.ts";
import {
  accountJson,
  appJson,
  authorJson,
  commentJson,
  conversionJson,
  installationJson,
  issueJson,
  labelJson,
  orgJson,
  pullRequestJson,
  repoJson,
  userJson,
  type Urls,
} from "./json.ts";
import { checkAppName, checkManifest, type ParsedManifest } from "./manifest.ts";
import {
  appPage,
  appSettingsPage,
  authorizePage,
  confirmationPage,
  installedPage,
  installPage,
  notFoundPage,
  refusalPage,
  signInPage,
} from "./pages.ts";
import { deliveryJson, deliverySummaryJson, type Deliveries } from "./webhooks.ts";
import type {
  Author,
  GitHubWorld,
  PendingRegistration,
  StubAccount,
  StubApp,
  StubInstallation,
  StubIssue,
  StubPullRequest,
  StubRepo,
  StubUser,
} from "./world.ts";

// The stub's two HTTP faces: github.com (web pages, the manifest flow, user
// authorization and its token endpoint) and api.github.com (the REST calls v1
// makes). Every request is recorded, with the credential it carried, so a
// test can check which token each call used.

export type StubHost = "web" | "api";

export interface StubRequest {
  readonly host: StubHost;
  readonly method: string;
  readonly url: URL;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type TokenKind = "app-jwt" | "installation" | "user" | "unknown";

export interface RecordedRequest {
  readonly host: StubHost;
  readonly method: string;
  /** The path, without the query string. */
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The credential in the Authorization header, and what the stub issued it as. */
  readonly token?: { kind: TokenKind; value: string };
  status: number;
}

export interface ServerContext {
  readonly world: GitHubWorld;
  readonly deliveries: Deliveries;
  readonly urls: () => Urls;
  /** The account a browser without the stub's cookie acts as. */
  webUser(): StubUser | undefined;
  /** Why GitHub would refuse a hook URL as unreachable, or undefined. */
  unreachable(url: URL): string | undefined;
}

/** The cookie that names the account a browser acts as on the stub's github.com. */
export const USER_COOKIE = "stub_user";

// Answers.

function html(body: string, status = 200, headers: Record<string, string> = {}): StubResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

function redirect(location: string, headers: Record<string, string> = {}): StubResponse {
  return { status: 302, headers: { location, ...headers } };
}

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-github-media-type": "github.v3; format=json",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-used": "1",
  "x-ratelimit-resource": "core",
} as const;

function json(status: number, value: unknown, headers: Record<string, string> = {}): StubResponse {
  return {
    status,
    headers: {
      ...API_HEADERS,
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-github-request-id": randomUUID().toUpperCase(),
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

function empty(status: number): StubResponse {
  return { status, headers: { "x-github-request-id": randomUUID().toUpperCase() } };
}

/** GitHub's error body: a message, a link to its documentation, and the status as a string. */
function apiError(status: number, message: string, documentationUrl = "https://docs.github.com/rest"): StubResponse {
  return json(status, { message, documentation_url: documentationUrl, status: String(status) });
}

const NOT_FOUND = (): StubResponse => apiError(404, "Not Found");
const BAD_CREDENTIALS = (): StubResponse => apiError(401, "Bad credentials");
const NOT_ACCESSIBLE = (): StubResponse => apiError(403, "Resource not accessible by integration");
const SUSPENDED = (): StubResponse => apiError(403, "This installation has been suspended");

// Requests.

function form(request: StubRequest): URLSearchParams {
  const type = request.headers["content-type"] ?? "";
  const text = request.body.toString("utf8");
  if (type.includes("application/json")) {
    const values = new URLSearchParams();
    try {
      for (const [key, value] of Object.entries(JSON.parse(text) as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") values.set(key, String(value));
      }
    } catch {
      // An unreadable body is an empty one.
    }
    return values;
  }
  return new URLSearchParams(text);
}

function jsonBody(request: StubRequest): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(request.body.toString("utf8") || "{}") as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function cookie(request: StubRequest, name: string): string | undefined {
  for (const pair of (request.headers["cookie"] ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function bearer(request: StubRequest): string | undefined {
  return /^(?:bearer|token)\s+(\S+)\s*$/i.exec(request.headers["authorization"] ?? "")?.[1];
}

type Route = [method: string, pattern: RegExp, handler: (request: StubRequest, params: string[]) => StubResponse | Promise<StubResponse>];

function dispatch(routes: Route[], request: StubRequest, notFound: () => StubResponse): StubResponse | Promise<StubResponse> {
  const path = request.url.pathname;
  let pathMatched = false;
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (match === null) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    return handler(request, match.slice(1).map((part) => decodeURIComponent(part)));
  }
  return pathMatched && request.host === "api" ? apiError(404, "Not Found") : notFound();
}

// Paging, as GitHub documents it: `per_page` 30 by default and at most 100, `page` from 1, and a Link header.

function paged<T>(urls: Urls, request: StubRequest, items: readonly T[]): { items: T[]; headers: Record<string, string> } {
  const asked = Number.parseInt(request.url.searchParams.get("per_page") ?? "", 10);
  const perPage = Number.isNaN(asked) || asked < 1 ? 30 : Math.min(asked, 100);
  const askedPage = Number.parseInt(request.url.searchParams.get("page") ?? "", 10);
  const page = Number.isNaN(askedPage) || askedPage < 1 ? 1 : askedPage;
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const linkTo = (target: number): string => {
    const query = new URLSearchParams(request.url.searchParams);
    query.set("per_page", String(perPage));
    query.set("page", String(target));
    return `<${urls.api}${request.url.pathname}?${query}>`;
  };
  const links: string[] = [];
  if (page > 1) links.push(`${linkTo(page - 1)}; rel="prev"`);
  if (page < last) links.push(`${linkTo(page + 1)}; rel="next"`, `${linkTo(last)}; rel="last"`);
  if (page > 1) links.push(`${linkTo(1)}; rel="first"`);
  return {
    items: items.slice((page - 1) * perPage, page * perPage),
    headers: links.length === 0 ? {} : { link: links.join(", ") },
  };
}

/** A GET answer with an entity tag, and 304 when the client already has it. */
function conditional(request: StubRequest, response: StubResponse): StubResponse {
  if (request.method !== "GET" || response.status !== 200 || response.body === undefined) return response;
  const etag = `W/"${createHash("sha256").update(response.body).digest("hex")}"`;
  if (request.headers["if-none-match"] === etag) return { status: 304, headers: { etag, "x-github-request-id": randomUUID().toUpperCase() } };
  return { ...response, headers: { ...response.headers, etag } };
}

// Callers of the API.

type Caller =
  | { kind: "none" }
  | { kind: "app"; app: StubApp }
  | { kind: "installation"; app: StubApp; installation: StubInstallation }
  | { kind: "user"; app: StubApp; user: StubUser };

export function tokenKind(world: GitHubWorld, token: string): TokenKind {
  if (looksLikeJwt(token)) return "app-jwt";
  if (world.installationTokens.has(token)) return "installation";
  if (world.userTokens.has(token)) return "user";
  return "unknown";
}

function authenticate(context: ServerContext, request: StubRequest): Caller | StubResponse {
  const { world } = context;
  const token = bearer(request);
  if (token === undefined) return { kind: "none" };
  if (looksLikeJwt(token)) {
    const checked = verifyAppJwt(
      token,
      (issuer) => {
        const app = world.appByIssuer(issuer);
        return app === undefined ? undefined : { app, publicKeys: app.publicKeys };
      },
      Math.floor(world.now() / 1000),
    );
    return checked.ok ? { kind: "app", app: checked.app } : apiError(401, checked.message);
  }
  const installationGrant = world.installationTokens.get(token);
  if (installationGrant !== undefined) {
    const installation = world.installations.get(installationGrant.installationId);
    if (installation === undefined || installation.deleted || installationGrant.expiresAt <= world.now()) return BAD_CREDENTIALS();
    if (installation.suspendedAt !== null) return SUSPENDED();
    return { kind: "installation", app: world.apps.get(installation.appId)!, installation };
  }
  const userGrant = world.userTokens.get(token);
  if (userGrant !== undefined && !userGrant.revoked && userGrant.expiresAt > world.now()) {
    const user = world.accountById(userGrant.userId);
    if (user?.type === "User") return { kind: "user", app: world.apps.get(userGrant.appId)!, user };
  }
  return BAD_CREDENTIALS();
}

function isResponse(value: unknown): value is StubResponse {
  return typeof value === "object" && value !== null && "status" in value;
}

function allows(permissions: Record<string, string>, key: string, level: "read" | "write"): boolean {
  const granted = permissions[key];
  return granted === "write" || (granted === "read" && level === "read");
}

/** The repository a caller may use, with the permission the call needs, and whom a write appears as. */
function repoFor(
  context: ServerContext,
  caller: Caller,
  owner: string,
  name: string,
  permission: [key: string, level: "read" | "write"] = ["metadata", "read"],
): { repo: StubRepo; author: Author | null } | StubResponse {
  const { world } = context;
  const repo = world.findRepo(`${owner}/${name}`);
  if (repo === undefined) return NOT_FOUND();
  switch (caller.kind) {
    case "installation":
      if (!world.reaches(caller.installation, repo)) return NOT_FOUND();
      if (!allows(caller.installation.permissions, permission[0], permission[1])) return NOT_ACCESSIBLE();
      return { repo, author: { kind: "bot", app: caller.app } };
    case "user": {
      const installed = world.installationsOf(caller.app).some((installation) => world.reaches(installation, repo));
      const owner = repo.owner;
      const canSee = owner.type === "User" ? owner.id === caller.user.id : world.isActiveMember(owner, caller.user);
      if (!installed || !canSee) return NOT_FOUND();
      if (!allows(caller.app.permissions, permission[0], permission[1])) return NOT_ACCESSIBLE();
      return { repo, author: { kind: "user", user: caller.user } };
    }
    case "app":
      return NOT_ACCESSIBLE();
    case "none":
      return repo.private || permission[1] === "write" ? NOT_FOUND() : { repo, author: null };
  }
}

// The handlers.

export interface StubHandlers {
  web(request: StubRequest): Promise<StubResponse>;
  api(request: StubRequest): Promise<StubResponse>;
  /** The manifest flow without a browser: what the new-App page and its confirmation do. */
  submitManifest(input: { manifest: string; org?: string; user?: StubUser; state?: string }): ManifestSubmission;
  confirmRegistration(id: string, name?: string): RegistrationOutcome;
  /** A user authorization without a browser, as if the user clicked Authorize. */
  authorize(app: StubApp, user: StubUser, redirectUri: string, codeChallenge: string | null): string;
}

export type ManifestSubmission =
  | { kind: "refused"; messages: string[] }
  | { kind: "not-found" }
  | { kind: "sign-in" }
  | { kind: "confirm"; registration: PendingRegistration };

export type RegistrationOutcome =
  | { kind: "unknown" }
  | { kind: "retry"; registration: PendingRegistration; message: string }
  | { kind: "created"; app: StubApp; code: string; location: URL };

export function createHandlers(context: ServerContext): StubHandlers {
  const { world, deliveries } = context;

  function webUserOf(request: StubRequest): StubUser | undefined {
    const login = cookie(request, USER_COOKIE);
    if (login !== undefined) {
      const account = world.findAccount(login);
      return account?.type === "User" ? account : undefined;
    }
    return context.webUser();
  }

  function signInFirst(request: StubRequest): StubResponse {
    return redirect(`/login?${new URLSearchParams({ return_to: `${request.url.pathname}${request.url.search}` })}`);
  }

  // The manifest flow.

  function submitManifest(input: { manifest: string; org?: string; user?: StubUser; state?: string }): ManifestSubmission {
    if (input.user === undefined) return { kind: "sign-in" };
    let owner: StubAccount = input.user;
    if (input.org !== undefined) {
      const org = world.findAccount(input.org);
      if (org?.type !== "Organization" || !world.administers(input.user, org)) return { kind: "not-found" };
      owner = org;
    }
    const checked = checkManifest(input.manifest, { unreachable: (url) => context.unreachable(url) });
    if (!checked.ok) return { kind: "refused", messages: checked.messages };
    const registration: PendingRegistration = { id: randomUUID(), manifest: checked.manifest, owner, state: input.state ?? null };
    world.pending.set(registration.id, registration);
    return { kind: "confirm", registration };
  }

  function confirmRegistration(id: string, name?: string): RegistrationOutcome {
    const registration = world.pending.get(id);
    if (registration === undefined) return { kind: "unknown" };
    const manifest: ParsedManifest = { ...registration.manifest, name: name?.trim() || registration.manifest.name };
    const refusal = checkAppName(manifest.name, (candidate) => world.appByName(candidate) !== undefined);
    if (refusal !== undefined) return { kind: "retry", registration: { ...registration, manifest }, message: refusal };
    world.pending.delete(id);
    const app = world.createApp(manifest, registration.owner);
    void deliveries.ping(app);
    const code = world.issueManifestCode(app);
    const settings = `${context.urls().web}${settingsPath(app)}`;
    const location = new URL(app.redirectUrl ?? settings);
    location.searchParams.set("code", code.code);
    if (registration.state !== null) location.searchParams.set("state", registration.state);
    return { kind: "created", app, code: code.code, location };
  }

  function settingsPath(app: StubApp): string {
    return app.owner.type === "User" ? `/settings/apps/${app.slug}` : `/organizations/${app.owner.login}/settings/apps/${app.slug}`;
  }

  function newApp(request: StubRequest, org: string | undefined): StubResponse {
    const user = webUserOf(request);
    const submitted = submitManifest({
      manifest: form(request).get("manifest") ?? "",
      ...(org === undefined ? {} : { org }),
      ...(user === undefined ? {} : { user }),
      ...(request.url.searchParams.has("state") ? { state: request.url.searchParams.get("state")! } : {}),
    });
    switch (submitted.kind) {
      case "sign-in":
        return html(signInPage(`${request.url.pathname}${request.url.search}`, "Sign in to register a GitHub App."));
      case "not-found":
        return html(notFoundPage(), 404);
      case "refused":
        return html(refusalPage(submitted.messages));
      case "confirm":
        return html(confirmationPage(submitted.registration.id, submitted.registration.manifest, submitted.registration.owner));
    }
  }

  function confirmNewApp(request: StubRequest): StubResponse {
    const fields = form(request);
    const outcome = confirmRegistration(fields.get("registration") ?? "", fields.get("name") ?? undefined);
    switch (outcome.kind) {
      case "unknown":
        return html(notFoundPage(), 404);
      case "retry":
        return html(confirmationPage(outcome.registration.id, outcome.registration.manifest, outcome.registration.owner, outcome.message));
      case "created":
        return redirect(outcome.location.href);
    }
  }

  // Installing.

  function installableAccounts(app: StubApp, user: StubUser): StubAccount[] {
    const candidates: StubAccount[] = [user, ...world.orgsOf(user)];
    return candidates.filter((account) => (app.public || account.id === app.owner.id) && world.administers(user, account));
  }

  async function install(request: StubRequest, slug: string): Promise<StubResponse> {
    const app = world.appBySlug(slug);
    const user = webUserOf(request);
    if (app === undefined) return html(notFoundPage(), 404);
    if (user === undefined) return signInFirst(request);
    const fields = form(request);
    const account = world.findAccount(fields.get("account") ?? "");
    if (account === undefined || !installableAccounts(app, user).some((candidate) => candidate.id === account.id)) return html(notFoundPage(), 404);
    const selected =
      fields.get("repository_selection") === "selected"
        ? fields.getAll("repositories").map((name) => world.findRepo(name)).filter((repo): repo is StubRepo => repo?.owner.id === account.id)
        : "all";
    const existed = world.liveInstallation(app, account) !== undefined;
    const installation = world.install(app, account, selected);
    if (!existed) void deliveries.installation(installation, "created", user);
    if (app.setupUrl !== null) {
      const setup = new URL(app.setupUrl);
      setup.searchParams.set("installation_id", String(installation.id));
      setup.searchParams.set("setup_action", existed ? "update" : "install");
      return redirect(setup.href);
    }
    return redirect(account.type === "User" ? `/settings/installations/${installation.id}` : `/organizations/${account.login}/settings/installations/${installation.id}`);
  }

  // User authorization.

  function authorize(app: StubApp, user: StubUser, redirectUri: string, codeChallenge: string | null): string {
    return world.issueAuthorizationCode(app, user, redirectUri, codeChallenge).code;
  }

  function callbackMatches(app: StubApp, uri: string): boolean {
    let target: URL;
    try {
      target = new URL(uri);
    } catch {
      return false;
    }
    return app.callbackUrls.some((callback) => {
      const registered = new URL(callback);
      const directory = registered.pathname.endsWith("/") ? registered.pathname : `${registered.pathname}/`;
      return registered.origin === target.origin && (target.pathname === registered.pathname || target.pathname.startsWith(directory));
    });
  }

  function back(uri: string, values: Record<string, string | null>): StubResponse {
    const location = new URL(uri);
    for (const [key, value] of Object.entries(values)) if (value !== null) location.searchParams.set(key, value);
    return redirect(location.href);
  }

  function authorizeStart(request: StubRequest, fields: URLSearchParams, decided?: "1" | "0"): StubResponse {
    const app = world.appByClientId(fields.get("client_id") ?? "");
    if (app === undefined || app.callbackUrls.length === 0) return html(notFoundPage(), 404);
    const state = fields.get("state");
    const redirectUri = fields.get("redirect_uri") ?? app.callbackUrls[0]!;
    if (!callbackMatches(app, redirectUri)) {
      return back(app.callbackUrls[0]!, {
        error: "redirect_uri_mismatch",
        error_description: "The redirect_uri MUST match the registered callback URL for this application.",
        error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-authorization-request-errors/#redirect-uri-mismatch",
        state,
      });
    }
    const user = webUserOf(request);
    if (user === undefined) return signInFirst(request);
    const challenge = fields.get("code_challenge");
    if (challenge !== null && (fields.get("code_challenge_method") ?? "S256") !== "S256") {
      return back(redirectUri, { error: "invalid_request", error_description: "Only the S256 code challenge method is supported.", state });
    }
    if (decided === "0") {
      return back(redirectUri, {
        error: "access_denied",
        error_description: "The user has denied your application access.",
        error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-authorization-request-errors/#access-denied",
        state,
      });
    }
    const known = world.authorizations.has(`${app.id}:${user.id}`) && fields.get("prompt") !== "consent";
    if (decided === "1" || known) return back(redirectUri, { code: authorize(app, user, redirectUri, challenge), state });
    const kept: Record<string, string> = {};
    for (const key of ["client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"]) {
      const value = fields.get(key);
      if (value !== null) kept[key] = value;
    }
    kept["redirect_uri"] = redirectUri;
    return html(authorizePage(app, user, kept));
  }

  function tokenAnswer(request: StubRequest, values: Record<string, string | number>): StubResponse {
    if ((request.headers["accept"] ?? "").includes("application/json")) {
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(values) };
    }
    const encoded = new URLSearchParams(Object.entries(values).map(([key, value]): [string, string] => [key, String(value)]));
    return { status: 200, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body: encoded.toString() };
  }

  const TOKEN_ERRORS = {
    incorrect_client_credentials: {
      error_description: "The client_id and/or client_secret passed are incorrect.",
      error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#incorrect-client-credentials",
    },
    bad_verification_code: {
      error_description: "The code passed is incorrect or expired.",
      error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code",
    },
    redirect_uri_mismatch: {
      error_description: "The redirect_uri MUST match the registered callback URL for this application.",
      error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#redirect-uri-mismatch",
    },
    bad_refresh_token: {
      error_description: "The refresh token passed is incorrect or expired.",
      error_uri: "https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens",
    },
  } as const;

  /** GitHub answers these refusals with 200 and an error in the body. */
  function tokenError(request: StubRequest, error: keyof typeof TOKEN_ERRORS): StubResponse {
    return tokenAnswer(request, { error, ...TOKEN_ERRORS[error] });
  }

  function accessToken(request: StubRequest): StubResponse {
    const fields = new URLSearchParams(request.url.searchParams);
    for (const [key, value] of form(request)) fields.set(key, value);
    const basic = /^basic\s+(\S+)$/i.exec(request.headers["authorization"] ?? "")?.[1];
    if (basic !== undefined) {
      const [id, ...secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
      fields.set("client_id", decodeURIComponent(id ?? ""));
      fields.set("client_secret", decodeURIComponent(secret.join(":")));
    }
    const app = world.appByClientId(fields.get("client_id") ?? "");
    if (app === undefined || !app.clientSecrets.includes(fields.get("client_secret") ?? "")) return tokenError(request, "incorrect_client_credentials");

    if (fields.get("grant_type") === "refresh_token") {
      const grant = world.refreshTokens.get(fields.get("refresh_token") ?? "");
      if (grant === undefined || grant.appId !== app.id || grant.revoked || grant.expiresAt <= world.now()) return tokenError(request, "bad_refresh_token");
      grant.revoked = true;
      const paired = grant.paired === null ? undefined : world.userTokens.get(grant.paired);
      if (paired !== undefined) paired.revoked = true;
      return issued(request, app, grant.userId);
    }

    const code = world.authorizationCodes.get(fields.get("code") ?? "");
    if (code === undefined || code.appId !== app.id || code.used || code.expiresAt <= world.now()) return tokenError(request, "bad_verification_code");
    const redirectUri = fields.get("redirect_uri");
    if (redirectUri !== null && redirectUri !== code.redirectUri) return tokenError(request, "redirect_uri_mismatch");
    if (code.codeChallenge !== null) {
      const verifier = fields.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code.codeChallenge) return tokenError(request, "bad_verification_code");
    }
    code.used = true;
    return issued(request, app, code.userId);
  }

  function issued(request: StubRequest, app: StubApp, userId: number): StubResponse {
    const { access, refresh } = world.issueUserTokens(app, userId);
    return tokenAnswer(request, {
      access_token: access.token,
      expires_in: 28_800,
      refresh_token: refresh.token,
      refresh_token_expires_in: 15_897_600,
      scope: "",
      token_type: "bearer",
    });
  }

  const webRoutes: Route[] = [
    ["GET", /^\/$/, () => html("<!doctype html><title>GitHub</title><h1>GitHub stub</h1>")],
    ["GET", /^\/login$/, (request) => html(signInPage(request.url.searchParams.get("return_to") ?? "/"))],
    [
      "POST",
      /^\/session$/,
      (request) => {
        const fields = form(request);
        const login = fields.get("login") ?? "";
        const account = world.findAccount(login);
        const returnTo = fields.get("return_to") ?? "/";
        if (account?.type !== "User") return html(signInPage(returnTo, "Incorrect username."), 422);
        const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
        return { status: 303, headers: { location: safe, "set-cookie": `${USER_COOKIE}=${encodeURIComponent(account.login)}; Path=/; HttpOnly; SameSite=Lax` } };
      },
    ],
    ["POST", /^\/settings\/apps\/new$/, (request) => newApp(request, undefined)],
    ["POST", /^\/organizations\/([^/]+)\/settings\/apps\/new$/, (request, [org]) => newApp(request, org!)],
    ["POST", /^\/settings\/apps\/new\/confirm$/, (request) => confirmNewApp(request)],
    [
      "GET",
      /^\/(?:settings|organizations\/[^/]+\/settings)\/apps\/([^/]+)$/,
      (_request, [slug]) => {
        const app = world.appBySlug(slug!);
        return app === undefined ? html(notFoundPage(), 404) : html(appSettingsPage(app));
      },
    ],
    [
      "GET",
      /^\/apps\/([^/]+)$/,
      (_request, [slug]) => {
        const app = world.appBySlug(slug!);
        return app === undefined ? html(notFoundPage(), 404) : html(appPage(app));
      },
    ],
    [
      "GET",
      /^\/apps\/([^/]+)\/installations\/new$/,
      (request, [slug]) => {
        const app = world.appBySlug(slug!);
        if (app === undefined) return html(notFoundPage(), 404);
        const user = webUserOf(request);
        if (user === undefined) return signInFirst(request);
        return html(installPage(app, installableAccounts(app, user), (account) => world.reposOf(account)));
      },
    ],
    ["POST", /^\/apps\/([^/]+)\/installations$/, (request, [slug]) => install(request, slug!)],
    [
      "GET",
      /^\/(?:settings|organizations\/[^/]+\/settings)\/installations\/(\d+)$/,
      (_request, [id]) => {
        const installation = world.installations.get(Number(id));
        if (installation === undefined || installation.deleted) return html(notFoundPage(), 404);
        return html(installedPage(world.apps.get(installation.appId)!, installation));
      },
    ],
    ["GET", /^\/login\/oauth\/authorize$/, (request) => authorizeStart(request, request.url.searchParams)],
    [
      "POST",
      /^\/login\/oauth\/authorize$/,
      (request) => {
        const fields = form(request);
        return authorizeStart(request, fields, fields.get("authorize") === "1" ? "1" : "0");
      },
    ],
    ["POST", /^\/login\/oauth\/access_token$/, (request) => accessToken(request)],
  ];

  // The API.

  function withCaller(
    request: StubRequest,
    handler: (caller: Caller) => StubResponse | Promise<StubResponse>,
  ): StubResponse | Promise<StubResponse> {
    const caller = authenticate(context, request);
    return isResponse(caller) ? caller : handler(caller);
  }

  function asApp(request: StubRequest, handler: (app: StubApp) => StubResponse | Promise<StubResponse>): StubResponse | Promise<StubResponse> {
    return withCaller(request, (caller) => {
      if (caller.kind !== "app") return apiError(401, "A JSON web token could not be decoded");
      return handler(caller.app);
    });
  }

  function asInstallation(
    request: StubRequest,
    handler: (installation: StubInstallation, app: StubApp) => StubResponse | Promise<StubResponse>,
  ): StubResponse | Promise<StubResponse> {
    return withCaller(request, (caller) => {
      if (caller.kind === "none") return apiError(401, "Requires authentication");
      if (caller.kind !== "installation") return NOT_ACCESSIBLE();
      return handler(caller.installation, caller.app);
    });
  }

  function asUser(request: StubRequest, handler: (user: StubUser, app: StubApp) => StubResponse): StubResponse | Promise<StubResponse> {
    return withCaller(request, (caller) => {
      if (caller.kind === "none") return apiError(401, "Requires authentication");
      if (caller.kind !== "user") return NOT_ACCESSIBLE();
      return handler(caller.user, caller.app);
    });
  }

  function installationOf(app: StubApp, id: string): StubInstallation | undefined {
    const installation = world.installations.get(Number(id));
    return installation === undefined || installation.deleted || installation.appId !== app.id ? undefined : installation;
  }

  /** The organization an installation may ask about: its own, and only with the Members permission. */
  function orgFor(installation: StubInstallation, login: string): StubAccount | StubResponse {
    const org = world.findAccount(login);
    if (org?.type !== "Organization") return NOT_FOUND();
    if (installation.account.id !== org.id || !allows(installation.permissions, "members", "read")) return NOT_ACCESSIBLE();
    return org;
  }

  function item(repo: StubRepo, number: string): StubIssue | StubPullRequest | undefined {
    return world.item(repo, Number(number));
  }

  function inBackground(work: Promise<unknown>): void {
    work.catch(() => {});
  }

  const apiRoutes: Route[] = [
    [
      "POST",
      /^\/app-manifests\/([^/]+)\/conversions$/,
      (_request, [code]) => {
        const found = world.manifestCodes.get(code!);
        if (found === undefined || found.used || found.expiresAt <= world.now()) {
          return apiError(404, "Not Found", "https://docs.github.com/rest/apps/apps#create-a-github-app-from-a-manifest");
        }
        found.used = true;
        return json(201, conversionJson(context.urls(), world.apps.get(found.appId)!));
      },
    ],
    ["GET", /^\/app$/, (request) => asApp(request, (app) => json(200, { ...appJson(context.urls(), app), installations_count: world.installationsOf(app).length }))],
    [
      "GET",
      /^\/app\/installations$/,
      (request) =>
        asApp(request, (app) => {
          const page = paged(context.urls(), request, world.installationsOf(app));
          return json(200, page.items.map((installation) => installationJson(context.urls(), world, installation)), page.headers);
        }),
    ],
    [
      "GET",
      /^\/app\/installations\/(\d+)$/,
      (request, [id]) =>
        asApp(request, (app) => {
          const installation = installationOf(app, id!);
          return installation === undefined ? NOT_FOUND() : json(200, installationJson(context.urls(), world, installation));
        }),
    ],
    [
      "POST",
      /^\/app\/installations\/(\d+)\/access_tokens$/,
      (request, [id]) =>
        asApp(request, (app) => {
          const installation = installationOf(app, id!);
          if (installation === undefined) return NOT_FOUND();
          if (installation.suspendedAt !== null) {
            return apiError(403, "This installation has been suspended", "https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app");
          }
          const grant = world.issueInstallationToken(installation);
          return json(201, {
            token: grant.token,
            expires_at: world.timestamp(grant.expiresAt),
            permissions: installationJson(context.urls(), world, installation)["permissions"],
            repository_selection: installation.selection,
          });
        }),
    ],
    [
      "GET",
      /^\/app\/hook\/deliveries$/,
      (request) =>
        asApp(request, (app) => {
          if (app.hook === null) {
            return apiError(404, "Not Found", "https://docs.github.com/rest/apps/webhooks#list-deliveries-for-an-app-webhook");
          }
          const asked = Number.parseInt(request.url.searchParams.get("per_page") ?? "", 10);
          const perPage = Number.isNaN(asked) || asked < 1 ? 30 : Math.min(asked, 100);
          const cursor = /^v1_(\d+)$/.exec(request.url.searchParams.get("cursor") ?? "")?.[1];
          const newestFirst = deliveries.of(app).sort((a, b) => b.id - a.id);
          const rest = cursor === undefined ? newestFirst : newestFirst.filter((delivery) => delivery.id < Number(cursor));
          const pageItems = rest.slice(0, perPage);
          const headers: Record<string, string> = {};
          if (rest.length > perPage) {
            const query = new URLSearchParams(request.url.searchParams);
            query.set("per_page", String(perPage));
            query.set("cursor", `v1_${pageItems.at(-1)!.id}`);
            headers["link"] = `<${context.urls().api}${request.url.pathname}?${query}>; rel="next"`;
          }
          return json(200, pageItems.map(deliverySummaryJson), headers);
        }),
    ],
    [
      "GET",
      /^\/app\/hook\/deliveries\/(\d+)$/,
      (request, [id]) =>
        asApp(request, (app) => {
          const delivery = deliveries.of(app).find((candidate) => candidate.id === Number(id));
          return delivery === undefined ? NOT_FOUND() : json(200, deliveryJson(delivery));
        }),
    ],
    [
      "POST",
      /^\/app\/hook\/deliveries\/(\d+)\/attempts$/,
      (request, [id]) =>
        asApp(request, (app) => {
          const delivery = deliveries.of(app).find((candidate) => candidate.id === Number(id));
          if (delivery === undefined) return NOT_FOUND();
          // GitHub accepts the redelivery at once and makes it afterwards.
          inBackground(deliveries.redeliver(app, delivery));
          return json(202, {});
        }),
    ],
    [
      "GET",
      /^\/installation\/repositories$/,
      (request) =>
        withCaller(request, (caller) => {
          if (caller.kind !== "installation") {
            return apiError(403, "You must authenticate with an installation access token in order to list repositories for an installation.");
          }
          const repositories = world.coveredRepos(caller.installation);
          const page = paged(context.urls(), request, repositories);
          return json(
            200,
            {
              total_count: repositories.length,
              repository_selection: caller.installation.selection,
              repositories: page.items.map((repo) => repoJson(context.urls(), repo)),
            },
            page.headers,
          );
        }),
    ],
    ["GET", /^\/user$/, (request) => asUser(request, (user) => json(200, userJson(context.urls(), user)))],
    [
      "GET",
      /^\/user\/emails$/,
      (request) =>
        asUser(request, (user, app) => {
          if (!allows(app.permissions, "emails", "read")) return NOT_ACCESSIBLE();
          return json(200, user.emails.map((email) => ({ ...email })));
        }),
    ],
    [
      "GET",
      /^\/user\/(\d+)$/,
      (request, [id]) =>
        withCaller(request, () => {
          const account = world.accountById(Number(id));
          return account === undefined ? NOT_FOUND() : json(200, account.type === "User" ? userJson(context.urls(), account) : accountJson(context.urls(), account));
        }),
    ],
    [
      "GET",
      /^\/users\/([^/]+)$/,
      (request, [login]) =>
        withCaller(request, () => {
          const account = world.findAccount(login!);
          return account === undefined ? NOT_FOUND() : json(200, account.type === "User" ? userJson(context.urls(), account) : accountJson(context.urls(), account));
        }),
    ],
    [
      "GET",
      /^\/orgs\/([^/]+)\/members\/([^/]+)$/,
      (request, [orgLogin, login]) =>
        asInstallation(request, (installation) => {
          const org = orgFor(installation, orgLogin!);
          if (isResponse(org)) return org;
          const user = world.findAccount(login!);
          return user?.type === "User" && org.type === "Organization" && world.isActiveMember(org, user) ? empty(204) : NOT_FOUND();
        }),
    ],
    [
      "GET",
      /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/,
      (request, [orgLogin, login]) =>
        asInstallation(request, (installation) => {
          const org = orgFor(installation, orgLogin!);
          if (isResponse(org) || org.type !== "Organization") return isResponse(org) ? org : NOT_FOUND();
          const user = world.findAccount(login!);
          const membership = user?.type === "User" ? org.members.get(user.id) : undefined;
          if (user === undefined || membership === undefined) return NOT_FOUND();
          const urls = context.urls();
          return json(200, {
            url: `${urls.api}/orgs/${org.login}/memberships/${user.login}`,
            state: membership.state,
            role: membership.role,
            organization_url: `${urls.api}/orgs/${org.login}`,
            organization: orgJson(urls, org),
            user: accountJson(urls, user),
          });
        }),
    ],
    [
      "GET",
      /^\/orgs\/([^/]+)\/members$/,
      (request, [orgLogin]) =>
        asInstallation(request, (installation) => {
          const org = orgFor(installation, orgLogin!);
          if (isResponse(org) || org.type !== "Organization") return isResponse(org) ? org : NOT_FOUND();
          const members = [...org.members.entries()]
            .filter(([, membership]) => membership.state === "active")
            .map(([id]) => world.accountById(id))
            .filter((account): account is StubUser => account?.type === "User")
            .sort((a, b) => a.id - b.id);
          const page = paged(context.urls(), request, members);
          return json(200, page.items.map((member) => accountJson(context.urls(), member)), page.headers);
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)$/,
      (request, [owner, name]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!);
          return isResponse(found) ? found : json(200, repoJson(context.urls(), found.repo));
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)\/pulls$/,
      (request, [owner, name]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["pull_requests", "read"]);
          if (isResponse(found)) return found;
          const query = request.url.searchParams;
          const state = query.get("state") ?? "open";
          const head = query.get("head");
          const base = query.get("base");
          const sort = query.get("sort") ?? "created";
          const direction = query.get("direction") ?? (sort === "created" ? "desc" : "asc");
          const pulls = world
            .itemsOf(found.repo)
            .filter((candidate): candidate is StubPullRequest => candidate.kind === "pull_request")
            .filter((pr) => state === "all" || pr.state === state)
            .filter((pr) => head === null || head === `${pr.repo.owner.login}:${pr.head.ref}`)
            .filter((pr) => base === null || base === pr.base.ref)
            .sort(order(sort === "updated" ? "updatedAt" : "createdAt", direction));
          const page = paged(context.urls(), request, pulls);
          return json(200, page.items.map((pr) => pullRequestJson(context.urls(), pr)), page.headers);
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["pull_requests", "read"]);
          if (isResponse(found)) return found;
          const pr = item(found.repo, number!);
          return pr?.kind === "pull_request" ? json(200, pullRequestJson(context.urls(), pr)) : NOT_FOUND();
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)\/issues$/,
      (request, [owner, name]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "read"]);
          if (isResponse(found)) return found;
          const query = request.url.searchParams;
          const state = query.get("state") ?? "open";
          const since = query.get("since");
          const labels = query.get("labels")?.split(",").filter((label) => label !== "") ?? [];
          const sort = query.get("sort") ?? "created";
          const issues = world
            .itemsOf(found.repo)
            .filter((candidate) => state === "all" || candidate.state === state)
            .filter((candidate) => since === null || Date.parse(candidate.updatedAt) >= Date.parse(since))
            .filter((candidate) => labels.every((label) => candidate.kind === "issue" && candidate.labels.includes(label)))
            .sort(order(sort === "updated" ? "updatedAt" : "createdAt", query.get("direction") ?? "desc"));
          const page = paged(context.urls(), request, issues);
          return json(200, page.items.map((issue) => issueJson(context.urls(), world, issue)), page.headers);
        }),
    ],
    [
      "POST",
      /^\/repos\/([^/]+)\/([^/]+)\/issues$/,
      (request, [owner, name]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "write"]);
          if (isResponse(found)) return found;
          const body = jsonBody(request);
          const title = body?.["title"];
          if (typeof title !== "string" || title === "") return apiError(422, "Invalid request.\n\n\"title\" wasn't supplied.");
          const labels = Array.isArray(body?.["labels"]) ? (body["labels"] as unknown[]).filter((label): label is string => typeof label === "string") : [];
          const issue = world.addIssue(found.repo, {
            title,
            body: typeof body?.["body"] === "string" ? body["body"] : null,
            labels,
            author: authorOf(found.author),
          });
          inBackground(deliveries.issue("opened", issue, senderOf(found.author)));
          return json(201, issueJson(context.urls(), world, issue));
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "read"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue === undefined) return NOT_FOUND();
          // GitHub names who closed an issue when it is read on its own, not in a listing or a delivery.
          const closedBy = issue.kind === "issue" && issue.closedBy !== null ? authorJson(context.urls(), issue.closedBy) : null;
          return json(200, { ...issueJson(context.urls(), world, issue), ...(issue.kind === "issue" ? { closed_by: closedBy } : {}) });
        }),
    ],
    [
      "PATCH",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "write"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue === undefined) return NOT_FOUND();
          const body = jsonBody(request) ?? {};
          const actions: string[] = [];
          if (typeof body["title"] === "string" && body["title"] !== issue.title) {
            issue.title = body["title"];
            actions.push("edited");
          }
          if (typeof body["body"] === "string" || body["body"] === null) {
            issue.body = body["body"] as string | null;
            if (!actions.includes("edited")) actions.push("edited");
          }
          if (issue.kind === "issue" && Array.isArray(body["labels"])) {
            issue.labels = [...new Set((body["labels"] as unknown[]).filter((label): label is string => typeof label === "string"))];
          }
          const state = body["state"];
          if ((state === "open" || state === "closed") && state !== issue.state) {
            issue.state = state;
            issue.closedAt = state === "closed" ? world.timestamp() : null;
            if (issue.kind === "issue" && state === "closed") issue.closedBy = authorOf(found.author);
            if (issue.kind === "issue") {
              const reason = body["state_reason"];
              issue.stateReason =
                state === "open" ? "reopened" : reason === "not_planned" || reason === "completed" ? reason : "completed";
            }
            actions.push(state === "closed" ? "closed" : "reopened");
          } else if (issue.kind === "issue" && issue.state === "closed" && (body["state_reason"] === "not_planned" || body["state_reason"] === "completed")) {
            issue.stateReason = body["state_reason"];
          }
          issue.updatedAt = world.timestamp();
          if (issue.kind === "issue") for (const action of actions) inBackground(deliveries.issue(action, issue, senderOf(found.author)));
          return json(200, issueJson(context.urls(), world, issue));
        }),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "read"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue === undefined) return NOT_FOUND();
          const comments = issue.kind === "issue" ? issue.comments : [];
          const page = paged(context.urls(), request, comments);
          return json(200, page.items.map((comment) => commentJson(context.urls(), issue, comment)), page.headers);
        }),
    ],
    [
      "POST",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "write"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue === undefined) return NOT_FOUND();
          const text = jsonBody(request)?.["body"];
          if (typeof text !== "string" || text === "") return apiError(422, "Invalid request.\n\n\"body\" wasn't supplied.");
          const comment = world.addComment(issue, text, authorOf(found.author));
          const urls = context.urls();
          if (issue.kind === "issue") {
            inBackground(
              deliveries.repository(
                issue.repo,
                "issue_comment",
                () => ({ action: "created", issue: issueJson(urls, world, issue), comment: commentJson(urls, issue, comment) }),
                senderOf(found.author),
              ),
            );
          }
          return json(201, commentJson(urls, issue, comment));
        }),
    ],
    [
      "POST",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/,
      (request, [owner, name, number]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "write"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue?.kind !== "issue") return NOT_FOUND();
          const body = JSON.parse(request.body.toString("utf8") || "[]") as unknown;
          const wanted = (Array.isArray(body) ? body : ((body as { labels?: unknown }).labels ?? [])) as unknown[];
          for (const label of wanted) {
            if (typeof label === "string" && !issue.labels.includes(label)) {
              issue.labels.push(label);
              inBackground(deliveries.issue("labeled", issue, senderOf(found.author), undefined, { label: labelJson(context.urls(), issue.repo, label) }));
            }
          }
          issue.updatedAt = world.timestamp();
          return json(200, issue.labels.map((label) => labelJson(context.urls(), issue.repo, label)));
        }),
    ],
    [
      "DELETE",
      /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/([^/]+)$/,
      (request, [owner, name, number, label]) =>
        withCaller(request, (caller) => {
          const found = repoFor(context, caller, owner!, name!, ["issues", "write"]);
          if (isResponse(found)) return found;
          const issue = item(found.repo, number!);
          if (issue?.kind !== "issue") return NOT_FOUND();
          if (!issue.labels.includes(label!)) return apiError(404, "Label does not exist");
          issue.labels = issue.labels.filter((candidate) => candidate !== label);
          issue.updatedAt = world.timestamp();
          inBackground(deliveries.issue("unlabeled", issue, senderOf(found.author), undefined, { label: labelJson(context.urls(), issue.repo, label!) }));
          return json(200, issue.labels.map((name) => labelJson(context.urls(), issue.repo, name)));
        }),
    ],
  ];

  /** Who a write appears as: its user, or the App's bot. Only an authenticated caller writes. */
  function senderOf(author: Author | null): StubUser | StubApp {
    if (author === null) throw new Error("an unauthenticated caller cannot write");
    return author.kind === "user" ? author.user : author.app;
  }

  function authorOf(author: Author | null): Author {
    if (author === null) throw new Error("an unauthenticated caller cannot write");
    return author;
  }

  return {
    async web(request) {
      return dispatch(webRoutes, request, () => html(notFoundPage(), 404));
    },
    async api(request) {
      return conditional(request, await dispatch(apiRoutes, request, NOT_FOUND));
    },
    submitManifest,
    confirmRegistration,
    authorize,
  };
}

function order<T extends { createdAt: string; updatedAt: string; number: number }>(
  field: "createdAt" | "updatedAt",
  direction: string,
): (a: T, b: T) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (a, b) => sign * (Date.parse(a[field]) - Date.parse(b[field]) || a.number - b.number);
}

