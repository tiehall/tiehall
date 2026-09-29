import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { Refusal } from "@tiehall/core";
import { z } from "zod";
import { createLogger, LOGGABLE, type Logger } from "./log.ts";

// The GitHub client (design.md, Technical decisions: T16; tracker-mirrors:
// GitHub writes appear as the App's bot; sign-in: Tiehall keeps no GitHub user
// token). Tiehall calls GitHub with the install's own GitHub App only: as the
// App, with a JSON web token whose issuer is the App's client id, or as one of
// the App's installations, with an installation token. It takes no other
// credential, so no call can carry a user's GitHub token or a token a client
// presented to Tiehall.
//
// Installation tokens (github-app-reachability: design.md, Design rules:
// Installation tokens; Technical decisions: T5): each is requested with the
// App's JWT, kept in memory until shortly before it expires, and sent on
// exactly as GitHub issued it. Nothing here assumes its length or its shape,
// because GitHub is moving these tokens to a format of about 520 characters,
// and nothing stores one: no column of the schema holds an installation token.
//
// One call takes no credential at all: the conversion of the code that
// GitHub's manifest flow returns into the new App's credentials
// (self-host-install: The GitHub App is created with GitHub's manifest flow).
//
// Conditional requests (tracker-mirrors: GitHub and Jira each run in webhook
// mode or polling mode; design.md, Self-hosting decisions: S9): each Octokit
// of the client remembers its latest GET answers with their entity tags, in
// memory, and asks for the same URL again with If-None-Match. GitHub answers
// an unchanged resource with 304, which does not count against its rate
// limit, and the client gives the remembered answer back. So the poll of
// polling mode, which reads the same listings every 60 seconds, costs GitHub's
// rate limit only when something changed.
//
// Bounded waits: every request to GitHub gives up after 10 seconds, unless
// the call gives a signal of its own, whatever it is: a call as the App or
// an installation, the installation token request before it, the key check,
// the manifest conversion and the sign-in's read of who signed in. A GitHub
// that stops answering then holds up no web request and no worker slot. A
// request that gives up fails like any other call GitHub does not answer: a
// job retries it, and a web action refuses as it does when GitHub fails.
//
// GitHub unavailable (public-api: One error model for Tiehall's own refusals;
// design.md, Technical decisions: T2): a call that GitHub answers with a
// status its caller gives no answer of its own for, such as a 5xx, a
// rate-limit refusal or a refused manifest code, or does not answer within its
// wait, throws one error, GitHubUnavailableError, whose message names the call
// and GitHub's status in Tiehall's own words. An action that asked GitHub,
// such as the look-up of an invite's username or the setup screen's exchange
// of the manifest's code, turns it into 502 integration-unavailable, having
// changed nothing.
//
// Every call Tiehall makes to GitHub's API goes through this module, on
// Octokit (tracker-mirrors: GitHub writes appear as the App's bot;
// agent-access: Outbound calls use Tiehall's own credentials): no other module
// builds an Octokit or a URL on GitHub's API. The one call made with a user's
// token is the sign-in's, which reads who signed in with the token GitHub
// issued for that sign-in, and nothing else. The OAuth code exchange of the
// sign-in goes to GitHub's web host, not its API, and stays with the sign-in
// service.

/** The App's credentials from the manifest conversion, as the setup screen stores them. */
export interface GitHubAppCredentials {
  /** The App's client id, the issuer of its JSON web tokens. */
  clientId: string;
  /** The App's private key, as PEM. */
  privateKey: string;
}

export interface GitHubClientOptions {
  /** GitHub's REST API; https://api.github.com unless a test points it at the GitHub stub. */
  apiUrl?: string;
  /** The fetch the calls go through; the platform's unless a test gives another. */
  fetch?: typeof fetch;
  logger?: Logger;
  /** How long one request waits for GitHub, unless the call gives its own signal; GITHUB_REQUEST_TIMEOUT_MS unless a test gives another. */
  timeoutMs?: number;
}

/** How long one request waits for GitHub before it gives up, unless the call gives its own signal. */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/** The fetch, with a timeout on every request that carries no signal of its own. */
function boundedFetch(options: GitHubClientOptions): typeof fetch {
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  return ((input: string | URL | Request, init?: RequestInit) =>
    (options.fetch ?? fetch)(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) })) as typeof fetch;
}

export interface GitHubClient {
  /** Calls GitHub as the App itself, such as `GET /app/installations`. */
  app(): Octokit;
  /** Calls GitHub as one installation of the App, with its installation token. */
  installation(installationId: number): Octokit;
}

export const GITHUB_API_URL = "https://api.github.com";

/** What every Octokit of the client shares: GitHub's API, Tiehall's user agent, the fetch with its timeout, and the logger. */
function octokitBase(options: GitHubClientOptions) {
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  return {
    baseUrl: options.apiUrl ?? GITHUB_API_URL,
    userAgent: "tiehall",
    request: { fetch: boundedFetch(options) },
    // Octokit's own notices, such as a retry after a 401, go through Tiehall's logger and its redaction.
    log: {
      debug: () => {},
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
    },
  };
}

/** How many GET answers each Octokit remembers for conditional requests; the one used longest ago goes first. */
const CONDITIONAL_ANSWERS = 500;

/** The HTTP status of a failed call to GitHub, or undefined when GitHub gave none. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * GitHub failed a call that an action needs: it answered with a status the
 * caller gives no answer of its own for, or did not answer within the
 * client's wait. Its message is Tiehall's own words, naming the call and
 * GitHub's status and nothing of the call's input, so the logger keeps it.
 */
export class GitHubUnavailableError extends Error {
  override name = "GitHubUnavailableError";
  readonly [LOGGABLE] = true;
  /** GitHub's HTTP status, or undefined when GitHub did not answer, or answered in a shape the call cannot use. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The GitHubUnavailableError for a call that failed with this error, which the
 * caller has already checked for the statuses it answers itself. `call` names
 * the call in Tiehall's words, such as "the look-up of the username". A
 * failure with no answer from GitHub, such as the client's timeout, carries no
 * status, although Octokit gives it one.
 */
export function gitHubUnavailable(call: string, error: unknown): GitHubUnavailableError {
  if (error instanceof GitHubUnavailableError) return error;
  const answered = (error as { response?: unknown } | undefined)?.response !== undefined;
  const status = answered ? statusOf(error) : undefined;
  const unavailable = new GitHubUnavailableError(
    status === undefined ? `GitHub did not answer ${call}, or could not be reached.` : `GitHub answered ${status} to ${call}.`,
    status,
  );
  unavailable.cause = error;
  return unavailable;
}

/** Makes every GET of this Octokit a conditional request, and serves GitHub's 304 from the answer it remembers. */
function conditionalRequests(octokit: Octokit): Octokit {
  const answers = new Map<string, { etag: string; response: Awaited<ReturnType<Octokit["request"]>> }>();
  octokit.hook.wrap("request", async (request, options) => {
    if (String(options.method).toUpperCase() !== "GET") return request(options);
    const url = octokit.request.endpoint.parse(options).url;
    const remembered = answers.get(url);
    // The hooks inside this one read the options this request was made with, so the header goes on them; each request has its own.
    if (remembered !== undefined) options.headers = { ...options.headers, "if-none-match": remembered.etag };
    try {
      const response = await request(options);
      const etag = response.headers.etag;
      answers.delete(url);
      if (typeof etag === "string" && etag !== "") {
        answers.set(url, { etag, response });
        if (answers.size > CONDITIONAL_ANSWERS) answers.delete(answers.keys().next().value!);
      }
      return response;
    } catch (error) {
      if (remembered === undefined || statusOf(error) !== 304) throw error;
      // Not modified: the remembered answer stands, and is now the one used last.
      answers.delete(url);
      answers.set(url, remembered);
      return remembered.response;
    }
  });
  return octokit;
}

export function createGitHubClient(credentials: GitHubAppCredentials, options: GitHubClientOptions = {}): GitHubClient {
  const base = octokitBase(options);
  const auth = { appId: credentials.clientId, privateKey: credentials.privateKey, log: base.log };
  const app = conditionalRequests(new Octokit({ ...base, authStrategy: createAppAuth, auth }));
  // One Octokit per installation, so each keeps its installation token in its own memory cache.
  const installations = new Map<number, Octokit>();
  return {
    app: () => app,
    installation(installationId) {
      let octokit = installations.get(installationId);
      if (octokit === undefined) {
        octokit = conditionalRequests(new Octokit({ ...base, authStrategy: createAppAuth, auth: { ...auth, installationId } }));
        installations.set(installationId, octokit);
      }
      return octokit;
    },
  };
}

/**
 * Whether GitHub issues an installation token to the App with these
 * credentials, such as a rotated private key before it is stored
 * (self-host-install: A rotated App key can be uploaded): true when GitHub
 * issued one, false when GitHub refused the App's JSON web token, as it does
 * one signed with a key of another App or a deleted one. It throws when GitHub
 * does not answer, or answers anything else. The token is used for nothing
 * else, and nothing keeps it.
 */
export async function requestInstallationToken(credentials: GitHubAppCredentials, installationId: number, options: GitHubClientOptions = {}): Promise<boolean> {
  const base = octokitBase(options);
  const octokit = new Octokit({ ...base, authStrategy: createAppAuth, auth: { appId: credentials.clientId, privateKey: credentials.privateKey, installationId, log: base.log } });
  try {
    await octokit.auth({ type: "installation" });
    return true;
  } catch (error) {
    if (statusOf(error) === 401) return false;
    throw error;
  }
}

/** The URL GitHub's Link header names as the next page, or undefined on the last page. */
function nextPage(link: string | undefined): string | undefined {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) return match[1];
  }
  return undefined;
}

/**
 * The pages of a GitHub listing, one at a time, as the client calls them: the
 * first page asked for with these parameters, and each next one by the URL
 * GitHub's Link header names, which may page by number or by cursor. A caller
 * that has read enough stops, and no further page is asked for.
 */
export async function* pagesOf(octokit: Octokit, route: string, parameters: Record<string, unknown>): AsyncGenerator<unknown> {
  let response = await octokit.request(route, parameters);
  yield response.data;
  for (let next = nextPage(response.headers.link); next !== undefined; next = nextPage(response.headers.link)) {
    response = await octokit.request(`GET ${next}`);
    yield response.data;
  }
}

/** Every page of a GitHub listing, as pagesOf() reads them. */
export async function everyPage(octokit: Octokit, route: string, parameters: Record<string, unknown>): Promise<unknown[]> {
  const pages: unknown[] = [];
  for await (const page of pagesOf(octokit, route, parameters)) pages.push(page);
  return pages;
}

/** Who signed in, as GitHub says: the account's numeric id and login, its primary verified email address, and its profile. */
export interface SignedInUser {
  id: number;
  login: string;
  /** The primary verified email address; undefined when the account has none, or GitHub did not give it. */
  primaryEmail: string | undefined;
  profile: Record<string, unknown>;
}

const SIGNED_IN_USER = z.looseObject({ id: z.number().int().positive(), login: z.string().min(1) });
const USER_EMAILS = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

/**
 * Reads who signed in, with the user token of that sign-in (sign-in: Tiehall
 * keeps no GitHub user token; sign-in: The email address comes from GitHub).
 * It is the one call Tiehall makes with a user's token, during the sign-in
 * that GitHub issued the token for, and the token is used for nothing else:
 * nothing keeps it. Undefined when GitHub does not say who signed in.
 */
export async function readSignedInUser(accessToken: string, options: GitHubClientOptions = {}): Promise<SignedInUser | undefined> {
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const octokit = new Octokit({ ...octokitBase(options), auth: accessToken });
  let profile;
  try {
    ({ data: profile } = await octokit.request("GET /user"));
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
    logger.warn("github: GitHub did not say who signed in", { status });
    return undefined;
  }
  const parsed = SIGNED_IN_USER.safeParse(profile);
  if (!parsed.success) return undefined;
  let primaryEmail: string | undefined;
  try {
    const { data } = await octokit.request("GET /user/emails");
    const emails = USER_EMAILS.safeParse(data);
    primaryEmail = emails.success ? emails.data.find((email) => email.primary && email.verified)?.email : undefined;
  } catch {
    primaryEmail = undefined;
  }
  return { id: parsed.data.id, login: parsed.data.login, primaryEmail, profile: parsed.data };
}

/**
 * A new App's credentials, as GitHub's manifest conversion returns them. GitHub
 * gives no webhook secret for an App created without a webhook
 * (github-app-reachability: design.md, Design rules: An App without a webhook).
 */
export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  /** The App's private key, as PEM. */
  privateKey: string;
  webhookSecret: string | null;
  owner: { login: string; type: "Organization" | "User" };
}

const CONVERSION = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pem: z.string().min(1),
  webhook_secret: z.string().min(1).nullable(),
  owner: z.object({ login: z.string().min(1), type: z.enum(["Organization", "User"]) }),
});

/** A manifest code as GitHub issues it: letters, digits, `_` and `-`. */
const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Exchanges the code GitHub's manifest flow returned for the new App's
 * credentials, at POST /app-manifests/{code}/conversions. GitHub converts a
 * code once, within an hour of issuing it. A code not in the form GitHub
 * issues codes in is refused as invalid input, 400, and GitHub is not asked.
 * It throws GitHubUnavailableError when GitHub does not convert the code,
 * whatever its status, or does not answer.
 */
export async function convertManifestCode(code: string, options: GitHubClientOptions = {}): Promise<ConvertedApp> {
  if (!MANIFEST_CODE.test(code)) {
    const message = "GitHub's return carries no code in the form GitHub issues.";
    throw new Refusal("invalid-input", message, { issues: [{ path: ["code"], message }] });
  }
  const octokit = new Octokit(octokitBase(options));
  let data: unknown;
  try {
    ({ data } = await octokit.request("POST /app-manifests/{code}/conversions", { code }));
  } catch (error) {
    throw gitHubUnavailable("the conversion of the manifest's code", error);
  }
  const parsed = CONVERSION.safeParse(data);
  if (!parsed.success) throw new GitHubUnavailableError("GitHub's conversion of the manifest's code lacks the App's credentials.");
  const app = parsed.data;
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    privateKey: app.pem,
    webhookSecret: app.webhook_secret,
    owner: { login: app.owner.login, type: app.owner.type },
  };
}
