import { createHash, randomBytes } from "node:crypto";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { requestWithThreadText, teamIntakeText, type RequestWithThreadJson, type TeamIntakeJson } from "@tiehall/packet/tool-text";
import type { Caller, WebSessionCaller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import { frameworkPagePolicy, refusalAnswerAs, wayOnFor, type WayOn } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { MEDIA_TYPES, NEGOTIATED_CACHE_CONTROL, NEGOTIATED_VARY, negotiate, negotiatedUrlOf, plainPathOf, type Representation, type RequestUrlPath } from "./negotiation.ts";
import { readRequestPage, requestPageFacts, type RequestWithThreadView } from "./request-page-data.ts";
import { withSessionCookies } from "./session-renewal.ts";
import { SIGN_IN_PATH } from "./sign-in.ts";

// Request URLs (agent-surfaces: Negotiated request URLs; agent-surfaces:
// Request URL response headers; agent-surfaces: No secret links;
// agent-surfaces: A browser without a session is sent to sign-in;
// agent-surfaces: A 401 that tells agents what to use; design.md, Design
// rules: Agent surfaces; design.md, Technical decisions: T3; design.md,
// Self-hosting decisions: S15). The web app's proxy, which runs before every
// route, answers a GET or HEAD of a request's URL, /<KEY> with or without the
// .md or .json suffix, written plainly or with percent-encoded characters, in
// the representation it negotiates (negotiation.ts),
// through execute('requests.get'), so a request URL reads a request exactly
// as /api/v1 does, for the same caller:
// - JSON is the body of the /api/v1 read, byte for byte, as agents read it;
// - markdown renders the same request and thread through the one renderer,
//   with every string Tiehall did not generate fenced with its origin as the
//   reader's teams make it;
// - HTML is the web UI's request page, which the app renders once the proxy
//   has let the call through, with the headers the proxy gives it: those of
//   every answer of a request URL, and those of every page of the web UI,
//   among them a content security policy whose script nonce is made for that
//   answer, which the proxy also hands Next.js with the call, so Next.js puts
//   it on the page's scripts.
// Who calls: HTML is the web UI, for a browser signed in with its web
// session; markdown and JSON take an agent's access token from the
// Authorization header alone, never from the query string, or a browser's web
// session. Without either, a call that negotiates HTML is sent to sign in and
// comes back to the URL, and one that negotiates markdown or JSON gets 401,
// whose problem says to read the request with `tiehall get <url>` or the MCP
// tool get_request; neither answer holds anything of the request (D28 #66;
// design.md, Readings to confirm with the founder: R17). A member who was
// removed gets 403, and a key that names no request 404: to a call that
// negotiates HTML as a page with a link on, to any other as the RFC 9457
// problem (public-api: One error model for Tiehall's own refusals;
// github-layer-hardening: design.md, Decisions this change rests on: D50 (7)).
// A key written with a team's earlier key, or one the request had before a
// reassignment, leads with 307 to the request's canonical URL, in the same
// representation: its current key, and the same suffix (requests:
// Reassignment gives a new key and the old key redirects; requests: Request
// keys that use a renamed team key keep resolving). Since an undo can lead a
// key back again, the redirect is temporary. Since the canonical key is data
// of the request, only a caller who may read it is led there.
//
// Team intake pages, /<TEAM> with or without .md or .json, are answered the
// same way (agent-surfaces: Team intake pages; design.md, Decisions this
// change rests on: D28 #64): they read the team through teams.get, whose
// /api/v1 body the JSON is, byte for byte; the markdown renders the team's
// name and intake notes, fenced, and the fields it requires, in Tiehall's
// words; HTML is the web UI's intake page. Without credentials, HTML is sent
// to sign in and markdown and JSON get 401, which names the MCP tool
// directory; a removed member gets 403, and a key no team has or had 404. A
// team's earlier key leads with 307 to its current key, with the same
// suffix.
//
// The methods (public-api: One error model for Tiehall's own refusals): a
// request URL and an intake page are read with GET or HEAD, and the web UI's
// page of a request also takes its forms' posts, which run the page's server
// action and are answered with the page again. A post is negotiated as the
// page is, for the browser's web session: without one it is sent to sign in, a
// removed member gets 403, and an old key leads with 307, which keeps the
// post, to the canonical URL. Any other call, a post to markdown, JSON or an
// intake page included, is to no route: 404 whoever makes it, before any
// credential or record is looked at, with nothing of the request or the team.
// So no call reaches the page without the proxy's negotiation; the page also
// renders only a call the proxy let through for its key (apps/web/app/[key]).
//
// Every answer sends Vary: Accept, Authorization, Cache-Control: private,
// no-store and an ETag: a JSON body's is strong, from its bytes; markdown's
// and the page's are weak, from the request as the caller reads it, the
// page's from its packet and its proposals too (request-page-data.ts), since
// each markdown answer fences with a nonce of its own and the page's forms
// carry the caller's own tokens; the page's answer to a post has one of its
// own, since it shows the request as the post left it; a refusal's and a
// redirect's are from what they answer. A read of the web session may renew
// it, and every answer then carries the cookie that renews it, the page's
// included (sign-in: Signing out and ending sessions; github-layer-hardening:
// design.md, Technical decisions: T4).

export interface RequestUrlOptions {
  execute: Execute;
  /**
   * The signed-in user's web session, from the request's session cookie;
   * undefined when nobody is signed in, a refusal for a session a removal
   * ended. The read may renew the session, and adds to `renewal` the cookies
   * the answer carries.
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** Who a call's access token acts for, from its Authorization header alone; undefined without one, a refusal for a token that is not valid. */
  authenticate(request: Request): Promise<Caller | undefined>;
  /** The install's URL (TIEHALL_URL), as its origin, on which a redirect's Location lies. */
  url: string;
  /** The URL of the protected resource metadata, which the challenge of a 401 points to. */
  resourceMetadata?: string;
  logger?: Logger;
}

/** How the proxy answers a call to a request URL: with this response, or by letting the web UI's page render with these headers. */
export type RequestUrlAnswer = { response: Response } | { page: { key: string; headers: Headers } };

/** Answers a call that is to a request URL; undefined for any other call, which goes on to its route. */
export type RequestUrlRoute = (request: Request) => Promise<RequestUrlAnswer | undefined>;

/** The headers every answer of a request URL carries. */
const URL_HEADERS = {
  vary: NEGOTIATED_VARY.join(", "),
  "cache-control": NEGOTIATED_CACHE_CONTROL,
  "x-content-type-options": "nosniff",
} as const;

/**
 * The content security policy of a page of the web UI that the Next.js app
 * renders, such as a request's page (agent-safety: The web UI renders no raw
 * HTML and no remote images; web-ui: The content security policy of each kind
 * of page): html.ts gives it, with a nonce made for each answer, so no text
 * the page shows, whoever wrote it, can make the browser run a script or fetch
 * anything from another host.
 */
export const pageContentSecurityPolicy = frameworkPagePolicy;

/**
 * The headers the web UI's page of a request gets besides, as every page of
 * the web UI has them: its content security policy, with a nonce of its own,
 * and its URL goes to no other site as a referrer.
 */
function pageHeaders(): Record<string, string> {
  return { "content-security-policy": pageContentSecurityPolicy(), "referrer-policy": "same-origin" };
}

/** The content type each representation is answered with. */
const CONTENT_TYPES: Readonly<Record<Exclude<Representation, "html">, string>> = {
  markdown: `${MEDIA_TYPES.markdown}; charset=utf-8`,
  json: MEDIA_TYPES.json,
};

/** The refusals of a call's token, whose challenge points to the protected resource metadata. */
const CHALLENGED: ReadonlySet<string> = new Set(["unauthenticated", "invalid-token", "insufficient-scope"]);

/** A hash of what an answer is, as an entity tag's opaque part. */
function digest(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\u0000");
  return hash.digest("base64url").slice(0, 32);
}

/** The ETag of a request as a caller reads it in one representation: weak, since the same request reads as other bytes each time. */
export function requestEtag(representation: Representation, caller: Caller, ...facts: readonly string[]): string {
  const reader = "userId" in caller && caller.userId !== undefined ? caller.userId : caller.kind;
  return `W/"${digest(representation, reader, ...facts)}"`;
}

export function createRequestUrlRoute(options: RequestUrlOptions): RequestUrlRoute {
  const logger = options.logger ?? createLogger();

  /** Who calls: for HTML, the browser's web session; for markdown and JSON, the access token in the Authorization header, or else the web session. */
  async function callerOf(request: Request, representation: Representation, renewal: Headers): Promise<Caller | undefined> {
    if (representation !== "html" && request.headers.get("authorization") !== null) {
      const token = await options.authenticate(request);
      if (token !== undefined) return token;
    }
    return options.session(request, renewal);
  }

  /** A refusal of a call's token, whose challenge points to the protected resource metadata; any other refusal as it is. */
  function challenged(refusal: Refusal): Refusal {
    const { resourceMetadata } = options;
    return resourceMetadata === undefined || !CHALLENGED.has(refusal.reason) ? refusal : refusal.withChallenge({ resourceMetadata });
  }

  /** Answers a team's intake page for a caller who may read it. */
  async function intakePage(
    caller: Caller,
    path: RequestUrlPath,
    representation: Representation,
    head: boolean,
    renewal: Headers,
    answer: (response: Response) => RequestUrlAnswer,
  ): Promise<RequestUrlAnswer> {
    const team = (await options.execute("teams.get", caller, { key: path.key }, { readOnly: true })) as TeamIntakeJson;
    if (team.key !== path.key) {
      // A team's earlier key: its current key, in the same representation.
      return answer(redirect(307, new URL(plainPathOf({ ...path, key: team.key }), options.url)));
    }
    if (representation === "html") {
      const headers = new Headers({ ...URL_HEADERS, ...pageHeaders(), etag: requestEtag("html", caller, JSON.stringify(team)) });
      for (const cookie of renewal.getSetCookie()) headers.append("set-cookie", cookie);
      return { page: { key: team.key, headers } };
    }
    if (representation === "json") {
      const body = JSON.stringify(agentJson(team));
      return answer(represented("json", head ? null : body, `"${digest("json", body)}"`));
    }
    // The reader's teams decide whether the team's text is fenced as their own team's or another team's.
    const whoami = (await options.execute("users.whoami", caller, {}, { readOnly: true })) as { teams: { key: string }[] };
    const teams = whoami.teams.map(({ key }) => key);
    const markdown = `${createAgentView().markdown(teamIntakeText(team, { teams }))}\n`;
    return answer(represented("markdown", head ? null : markdown, requestEtag("markdown", caller, JSON.stringify(team), teams.join(","))));
  }

  return async function requestUrl(request) {
    const url = new URL(request.url);
    const path = negotiatedUrlOf(url.pathname);
    if (path === undefined) return undefined;
    const representation = negotiate(request.headers.get("accept"), path.suffix);
    const head = request.method === "HEAD";
    const post = request.method === "POST";
    // The URL as it is written plainly, where a browser signs in and comes back to, and which a refusal's page leads on to.
    const plain = plainPathOf(path);
    const renewal = new Headers();
    const answer = (response: Response): RequestUrlAnswer => ({ response: withSessionCookies(response, renewal) });
    try {
      // Read with GET or HEAD; a request's page also takes its forms' posts. Any other call is to no route, whoever makes it.
      if (!(request.method === "GET" || head || (post && path.kind === "request" && representation === "html"))) {
        throw new Refusal("route-not-found", "There is no such page here.");
      }
      const caller = await callerOf(request, representation, renewal);
      if (caller === undefined) {
        // A browser signs in and comes back; an agent is told what reads a request, or the install's teams, for it.
        if (representation === "html") return answer(redirect(303, new URL(`${SIGN_IN_PATH}?return=${encodeURIComponent(plain)}`, options.url)));
        throw new Refusal(
          "unauthenticated",
          path.kind === "team"
            ? "A team's intake page answers only members of this install. Read the install's teams with the MCP tool directory, or send your access token in the Authorization header."
            : "A request URL answers only members of this install. Read the request with `tiehall get <url>`, once `tiehall login` has signed you in, or with the MCP tool get_request; or send your access token in the Authorization header.",
          { challenge: { scope: ["requests:read"] } },
        );
      }
      if (path.kind === "team") return await intakePage(caller, path, representation, head, renewal, answer);
      const read = (await options.execute("requests.get", caller, { key: path.key }, { readOnly: true })) as RequestWithThreadJson & RequestWithThreadView;
      if (read.key !== path.key) {
        // A key written with a team's earlier key, or from before a reassignment: the canonical URL, in the same representation.
        return answer(redirect(307, new URL(plainPathOf({ ...path, key: read.key }), options.url)));
      }
      if (post) {
        // A form's post to the page, which the page's server action runs and answers with the page as the post leaves it.
        const headers = new Headers({ ...URL_HEADERS, ...pageHeaders(), etag: `W/"${digest("post", randomBytes(18).toString("base64"))}"` });
        for (const cookie of renewal.getSetCookie()) headers.append("set-cookie", cookie);
        return { page: { key: read.key, headers } };
      }
      if (representation === "html") {
        // The page's ETag follows everything the page shows of the request: its thread, its packet and its proposals.
        const page = await readRequestPage((commandId, input) => options.execute(commandId, caller, input, { readOnly: true }) as never, read.key, read);
        const headers = new Headers({ ...URL_HEADERS, ...pageHeaders(), etag: requestEtag("html", caller, ...requestPageFacts(page)) });
        for (const cookie of renewal.getSetCookie()) headers.append("set-cookie", cookie);
        return { page: { key: read.key, headers } };
      }
      if (representation === "json") {
        const body = JSON.stringify(agentJson(read));
        return answer(represented("json", head ? null : body, `"${digest("json", body)}"`));
      }
      // The reader's teams decide each fence's origin: their own team's text, another team's, or external.
      const whoami = (await options.execute("users.whoami", caller, {}, { readOnly: true })) as { teams: { key: string }[] };
      const teams = whoami.teams.map(({ key }) => key);
      const markdown = `${createAgentView().markdown(requestWithThreadText(read, { teams }))}\n`;
      return answer(represented("markdown", head ? null : markdown, requestEtag("markdown", caller, JSON.stringify(read), teams.join(","))));
    } catch (error) {
      if (!(error instanceof Refusal)) logger.error("request URL: the read failed", { error });
      const problem = error instanceof Refusal ? httpProblem(challenged(error)) : internalErrorProblem();
      // A browser asked for the page again, unless a removal ended its session, which would refuse it again: then to sign in.
      const again: WayOn = { href: plain, text: "Open the page again" };
      return answer(refused(representation === "html", problem, error instanceof Refusal ? wayOnFor(error.reason, again) : again, head));
    }
  };
}

/** A representation's answer, with the headers of every answer of a request URL. */
function represented(representation: Exclude<Representation, "html">, body: string | null, etag: string): Response {
  return new Response(body, { status: 200, headers: { ...URL_HEADERS, "content-type": CONTENT_TYPES[representation], etag } });
}

/**
 * A redirect, to sign-in or to the canonical URL, on the install's URL, with
 * the headers of every answer of a request URL. Its Location is absolute, as
 * Next.js needs a proxy's redirect to be; Next.js writes it as a path when it
 * lies on the host the call was made to.
 */
function redirect(status: 303 | 307, location: URL): Response {
  return new Response(null, { status, headers: { ...URL_HEADERS, location: location.toString(), etag: `"${digest(String(status), location.toString())}"` } });
}

/** A refusal: a page for a call that negotiates HTML, the problem for any other, with the headers of every answer of a request URL. */
function refused(html: boolean, problem: HttpProblem, wayOn: WayOn, head: boolean): Response {
  const { status, headers, body } = refusalAnswerAs(html, problem, wayOn);
  for (const [name, value] of Object.entries(URL_HEADERS)) headers.set(name, value);
  headers.set("etag", `"${digest(String(status), body)}"`);
  return new Response(head ? null : body, { status, headers });
}
