import { approveAgentClient, SCOPES } from "@tiehall/catalog";
import { canonicalJson, httpProblem, internalErrorProblem, Refusal, type HttpProblem, type Review, type ReviewLine } from "@tiehall/core";
import { readAgentClient, type AgentClient } from "./agent-clients.ts";
import { AUTHORIZATION_ENDPOINT_PATH, CONSENT_PATH, REFRESH_SCOPE } from "./authorization-server.ts";
import type { WebSessionCaller } from "./caller.ts";
import { CONFIRM_PATH, renderReviewPage } from "./confirm-route.ts";
import type { ConfirmationStep } from "./confirmation-step.ts";
import { answerRefusal, PAGE_HEADERS, wayOnFor, webPagePolicy } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { csrfTokenFor } from "./web-writes.ts";
import type { OrgContext } from "./with-org.ts";

// The consent screen, at /consent (agent-access: The consent screen shows who
// is asking; design.md, Design rules: Agent access; design.md, Self-hosting
// decisions: S1 and S7). When an agent client asks a signed-in member to
// approve it, the authorization server sends the browser here with the
// authorization request. The page says, in Tiehall's own words, who is asking:
// - the name the client gives itself, which is its own claim, quoted as text
//   from outside Tiehall, escaped like every piece of text on a page;
// - for a client identified by its Client ID Metadata Document, the verified
//   host of the document's URL; for a registered client, a warning that it is
//   unverified;
// - the host name of the redirect URI the browser returns to, which must be
//   one the client registered, and a warning when every redirect URI of the
//   client is on the computer it runs on (localhost);
// - what the client may do for the member: the scopes it asks for, which
//   are only ones Tiehall offers; a page whose address names anything else,
//   which the authorization server never sends a browser to, is refused with
//   400, so no words but Tiehall's own read as Tiehall's.
// It asks for no choice of org, since the install has one. A browser without a
// session is sent to sign in first, and comes back to the page. The page runs
// no script, loads nothing and cannot be framed; a refusal is a page for a
// browser and a problem for any other client (html.ts).
//
// The consent screen is the review page of the approval (agent-access:
// Approving an agent client uses the confirmation step; agent-grants.ts): the
// confirmation step reviews the approval of this authorization request for
// the signed-in member, and the page's form posts it to the confirmation
// step, /confirm/agent_clients.approve, with a nonce bound to the member,
// their web session and this approval, and the session's CSRF token.
//
// A browser applies the page's form-action to every redirect that follows its
// form's post, and a confirmed approval ends in one to the client's redirect
// URI, with the code: the confirmation step sends the browser back to the
// authorization, which sends it on to the client. So the page's form may lead
// to the install and to the redirect URI of the request it shows, which the
// client registered, and to nowhere else (consentPolicy()).
//
// An authorization started before its person signed in reaches the sign-in
// page, which brings the browser back to the authorization once it has signed
// in: continuePathOf() gives the authorization request as the client sent it,
// without the signature the authorization server added to it for the page,
// and without the refresh scope the server adds itself. When the person
// approved the client before, that authorization sends the browser on to the
// client's redirect URI at once, as the last redirect after the sign-in
// page's form's post; so the sign-in page's form may lead to that redirect
// URI too, when the client registered it (registeredRedirectIn()).

/** The parameters the authorization server adds to the request it sends to the sign-in page or the consent screen. */
const SIGNATURE_PARAMETERS: ReadonlySet<string> = new Set(["sig", "exp", "ba_iat", "ba_param", "ba_pl"]);

/** An authorization request, as the consent screen reads it. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  /** The scopes it asks for, as Tiehall offers them. */
  scopes: string[];
  /** The request's parameters as the client sent them. */
  parameters: URLSearchParams;
}

/** An authorization request's parameters as the client sent them, from the query the authorization server passed on. */
export function clientParametersOf(query: URLSearchParams): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const [name, value] of query) {
    if (SIGNATURE_PARAMETERS.has(name)) continue;
    if (name === "scope") parameters.append(name, offeredScopes(value).join(" "));
    else parameters.append(name, value);
  }
  return parameters;
}

/** Where an authorization goes on: the authorization endpoint with the request as the client sent it. */
export function continuePathOf(query: URLSearchParams): string {
  return `${AUTHORIZATION_ENDPOINT_PATH}?${clientParametersOf(query).toString()}`;
}

/** Whether a query is that of an authorization request the authorization server passed on to a page. */
export function isAuthorizationRequest(query: URLSearchParams): boolean {
  return query.get("response_type") !== null && query.get("client_id") !== null;
}

function offeredScopes(scope: string): string[] {
  return scope.split(" ").filter((each) => each !== "" && each !== REFRESH_SCOPE);
}

/** The authorization request a page's query holds; refused with 400 when it names no client or no redirect URI. */
export function authorizationRequestOf(query: URLSearchParams): AuthorizationRequest {
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  if (clientId === "" || redirectUri === "") {
    throw new Refusal("invalid-input", "This page shows an agent client's authorization request, and this one names no client or no redirect URI.");
  }
  return { clientId, redirectUri, scopes: offeredScopes(query.get("scope") ?? ""), parameters: clientParametersOf(query) };
}

/** What the consent screen shows: the client as the install knows it, where the browser returns, and what it asks for. */
export interface ConsentView {
  client: Pick<AgentClient, "name" | "verifiedHost" | "unverified" | "redirectUris">;
  redirectUri: string;
  scopes: readonly string[];
}

/** What each scope lets a client do, in Tiehall's own words. */
export const SCOPE_TEXTS: Readonly<Record<string, string>> = {
  "requests:read": "requests:read: read the install's requests, their messages and packets, and what changed on them",
  "requests:write": "requests:write: open requests, post messages, and claim and work on requests, as you may",
  "contracts:report": "contracts:report: attach classified contract changes to a request",
};

/**
 * Whether a redirect URI is one the client registered: the same URI, or, for
 * a native client's return to its own computer over http, the same URI on
 * another port, since such a client listens on whatever port is free when it
 * runs (RFC 8252), as the authorization server allows too.
 */
export function isRegisteredRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const withoutPort = (uri: string): string | undefined => {
    try {
      const url = new URL(uri);
      if (url.protocol !== "http:" || !isLocalhost(uri) || url.username !== "" || url.password !== "" || uri.includes("#")) return undefined;
      return `${url.protocol}//${url.hostname}${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  };
  const a = withoutPort(registered);
  return a !== undefined && a === withoutPort(requested);
}

/** Whether a redirect URI is on the computer the client runs on. */
function isLocalhost(uri: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

/**
 * Where the browser returns to, as the consent screen names it: the redirect
 * URI's host name, or, for a URI with none, such as a native app's
 * private-use scheme (RFC 8252, 7.1), the app at that scheme.
 */
function returnsTo(uri: string): string {
  try {
    const url = new URL(uri);
    return url.hostname === "" ? `the app at ${url.protocol}` : url.hostname;
  } catch {
    return uri;
  }
}

/** The consent screen's content: who is asking and what for, in Tiehall's own words, with the client's own name quoted. */
export function consentReview({ client, redirectUri, scopes }: ConsentView): Review {
  const lines: ReviewLine[] = [];
  if (client.name === undefined || client.name.trim() === "") lines.push({ text: "An agent client that gives no name asks to act for you in Tiehall." });
  else lines.push({ text: "An agent client asks to act for you in Tiehall. It calls itself:" }, { quote: client.name, origin: "external" });
  if (client.verifiedHost !== undefined) {
    lines.push({ text: `Its identity is verified: it is identified by its metadata document on ${client.verifiedHost}, its verified host.` });
  } else {
    lines.push({
      text: "Unverified client: it registered itself with this install, so nothing checks that it is what its name says. Approve it only if you just connected an agent yourself.",
    });
  }
  lines.push({ text: `After you approve it, your browser returns to ${returnsTo(redirectUri)}.` });
  if (client.redirectUris.length > 0 && client.redirectUris.every(isLocalhost)) {
    lines.push({
      text: "Every address this client can send you back to is on localhost, the computer it runs on. Continue only if you started this from an agent on your own computer.",
    });
  }
  lines.push({ text: "It asks to:" });
  for (const scope of scopes) lines.push({ text: SCOPE_TEXTS[scope] ?? scope });
  lines.push({
    text: "It will act as you, within your role, until you revoke it on your Connected agents and tokens page. A commitment it proposes still takes effect only once a person confirms it here.",
  });
  return { title: "Approve an agent client", lines };
}

/**
 * The consent screen's view of an authorization request, read in the caller's
 * transaction: 404 for a client the install does not know, 400 for a return
 * address the client did not register, and 400 for a request that asks for no
 * scope or for one Tiehall does not offer.
 */
export async function consentViewIn(context: Pick<OrgContext, "tx" | "orgId">, request: AuthorizationRequest): Promise<ConsentView & { client: AgentClient }> {
  const client = await readAgentClient(context, request.clientId);
  if (client === undefined || client.disabled) throw new Refusal("record-not-found", "The install knows no agent client with this id.");
  if (!client.redirectUris.some((registered) => isRegisteredRedirect(registered, request.redirectUri))) {
    throw new Refusal("invalid-input", "The client did not register the address this request would send you back to.");
  }
  if (request.scopes.length === 0 || request.scopes.some((scope) => !(SCOPES as readonly string[]).includes(scope))) {
    throw new Refusal("invalid-input", `An agent client asks for one or more of ${SCOPES.join(", ")}, and for nothing else.`);
  }
  return { client, redirectUri: request.redirectUri, scopes: request.scopes };
}

/**
 * How a page's form-action names a client's redirect URI, where a form's post
 * may end: a web address by its origin, and a native client's own scheme, such
 * as cursor:, by the scheme. A host a policy cannot name, such as [::1], or
 * one whose characters would be read as more of the policy, such as ; or *,
 * which a URL's host may hold, is named by its scheme instead, so the client's
 * registration never adds anything else to the policy.
 */
export function redirectSourceOf(redirectUri: string): string {
  const url = new URL(redirectUri);
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && /^[a-z0-9.-]+$/i.test(url.hostname) ? url.origin : url.protocol;
}

/** The pages' own Content-Security-Policy, whose form may also lead to these sources. */
export function policyWithFormAction(sources: readonly string[]): string {
  return webPagePolicy(sources);
}

/**
 * The consent screen's Content-Security-Policy: the pages' own, whose form may
 * also lead to the client's redirect URI, where the approval ends.
 */
export function consentPolicy(redirectUri: string): string {
  return policyWithFormAction([redirectSourceOf(redirectUri)]);
}

/**
 * The redirect URI of the authorization request a page's query holds, when
 * the install knows the client, has not disabled it and the client registered
 * that redirect URI; undefined for any other, such as one crafted into the
 * page's address, which no form's post may then lead to.
 */
export async function registeredRedirectIn(context: Pick<OrgContext, "tx" | "orgId">, query: URLSearchParams): Promise<string | undefined> {
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  if (clientId === "" || redirectUri === "") return undefined;
  const client = await readAgentClient(context, clientId);
  if (client === undefined || client.disabled) return undefined;
  return client.redirectUris.some((registered) => isRegisteredRedirect(registered, redirectUri)) ? redirectUri : undefined;
}

export interface ConsentRouteOptions {
  /** The confirmation step, whose review of the approval the page shows, with its nonce. */
  step: ConfirmationStep;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: string | (() => string);
  /**
   * The web session the request's cookie names; undefined when nobody is
   * signed in, a refusal for an ended session. The read may renew the
   * session, and adds to `renewal` the cookies the answer carries.
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  logger?: Logger;
}

export type ConsentRoute = (request: Request) => Promise<Response>;

export function createConsentRoute(options: ConsentRouteOptions): ConsentRoute {
  const logger = options.logger ?? createLogger();
  const secret = () => (typeof options.secret === "string" ? options.secret : options.secret());
  return (request) => renewingSession((renewal) => consent(request, renewal));

  async function consent(request: Request, renewal: Headers): Promise<Response> {
    const url = new URL(request.url);
    const back = { href: `${url.pathname}${url.search}`, text: "Open the page again" };
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request, renewal);
      // A browser without a session signs in first, and comes back to this page.
      if (caller === undefined) return signInFirst(`${url.pathname}${url.search}`);
      const authorization = authorizationRequestOf(url.searchParams);
      // The approval's review, with the nonce for this one approval, as the confirmation step gives it.
      const reviewed = await options.step.review(approveAgentClient.id, caller, { authorization: authorization.parameters.toString() });
      const page = renderReviewPage(
        `${CONFIRM_PATH}${approveAgentClient.id}`,
        reviewed.review,
        canonicalJson(reviewed.input),
        reviewed.nonce,
        csrfTokenFor(secret(), caller.sessionId),
      );
      return new Response(page, { headers: { ...PAGE_HEADERS, "content-security-policy": consentPolicy(authorization.redirectUri) } });
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), wayOnFor(error.reason, back));
      logger.error("consent: the consent screen failed", { error });
      return problem(internalErrorProblem());
    }
  }
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] } });
}

/** Sends a browser without a session to the sign-in page, which brings it back to this path; the answer holds nothing of the page. */
function signInFirst(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `/sign-in?return=${encodeURIComponent(path)}`,
      "cache-control": "no-store",
      "content-security-policy": PAGE_HEADERS["content-security-policy"],
    },
  });
}

export { CONSENT_PATH };
