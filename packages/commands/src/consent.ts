import { httpProblem, internalErrorProblem, quotePreamble, Refusal, type HttpProblem, type Review, type ReviewLine } from "@tiehall/core";
import type { Database } from "@tiehall/db";
import { readAgentClient, type AgentClient } from "./agent-clients.ts";
import { AUTHORIZATION_ENDPOINT_PATH, CONSENT_PATH, REFRESH_SCOPE } from "./authorization-server.ts";
import type { WebSessionCaller } from "./caller.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { withOrg } from "./with-org.ts";

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
// - what the client may do for the member: the scopes it asks for.
// It asks for no choice of org, since the install has one. A browser without a
// session is sent to sign in first, and comes back to the page. The page runs
// no script, loads nothing and cannot be framed; a refusal is a page for a
// browser and a problem for any other client (html.ts).
//
// An authorization started before its person signed in reaches the sign-in
// page, which brings the browser back to the authorization once it has signed
// in: continuePathOf() gives the authorization request as the client sent it,
// without the signature the authorization server added to it for the page,
// and without the refresh scope the server adds itself.

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
const SCOPE_TEXTS: Readonly<Record<string, string>> = {
  "requests:read": "requests:read: read the install's requests, their messages and packets, and what changed on them",
  "requests:write": "requests:write: open requests, post messages, and claim and work on requests, as you may",
  "contracts:report": "contracts:report: attach classified contract changes to a request",
};

/** Whether a redirect URI is on the computer the client runs on. */
function isLocalhost(uri: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

function hostNameOf(uri: string): string {
  try {
    return new URL(uri).hostname;
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
  lines.push({ text: `After you approve it, your browser returns to ${hostNameOf(redirectUri)}.` });
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

/** The consent screen's view of an authorization request, read as the signed-in member; 404 for a client the install does not know. */
export async function readConsentView(database: Database, caller: WebSessionCaller, request: AuthorizationRequest): Promise<ConsentView> {
  return withOrg(
    database,
    async (context) => {
      const client = await readAgentClient(context, request.clientId);
      if (client === undefined || client.disabled) throw new Refusal("record-not-found", "The install knows no agent client with this id.");
      if (!client.redirectUris.includes(request.redirectUri)) {
        throw new Refusal("invalid-input", "The client did not register the address this request would send you back to.");
      }
      return { client, redirectUri: request.redirectUri, scopes: request.scopes };
    },
    { readOnly: true, forUser: caller.userId },
  );
}

export interface ConsentRouteOptions {
  /** The app's database, as the app role. */
  database: Database;
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
      const view = await readConsentView(options.database, caller, authorization);
      return new Response(consentPage(consentReview(view)), { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), back);
      logger.error("consent: the consent screen failed", { error });
      return problem(internalErrorProblem());
    }
  }
}

/** The consent screen's page. */
function consentPage(review: Review): string {
  const lines = review.lines.map((line) =>
    "text" in line
      ? `      <p>${escapeHtml(line.text)}</p>`
      : `      <blockquote class="untrusted" data-origin="${escapeHtml(line.origin)}"><p>${escapeHtml(quotePreamble(line.origin))}</p><pre>${escapeHtml(line.quote)}</pre></blockquote>`,
  );
  return htmlPage(review.title, [`      <h1>${escapeHtml(review.title)}</h1>`, ...lines].join("\n"));
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
