import { createHash } from "node:crypto";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { requestWithThreadText, type RequestWithThreadJson } from "@tiehall/packet/tool-text";
import type { Caller, WebSessionCaller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import { refusalAnswerAs, type WayOn } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { MEDIA_TYPES, NEGOTIATED_VARY, negotiate, requestUrlOf, type Representation } from "./negotiation.ts";
import { withSessionCookies } from "./session-renewal.ts";
import { SIGN_IN_PATH } from "./sign-in.ts";

// Request URLs (agent-surfaces: Negotiated request URLs; agent-surfaces:
// Request URL response headers; agent-surfaces: No secret links;
// agent-surfaces: A browser without a session is sent to sign-in;
// agent-surfaces: A 401 that tells agents what to use; design.md, Design
// rules: Agent surfaces; design.md, Technical decisions: T3; design.md,
// Self-hosting decisions: S15). The web app's proxy, which runs before every
// route, answers a GET or HEAD of a request's URL, /<KEY> with or without the
// .md or .json suffix, in the representation it negotiates (negotiation.ts),
// through execute('requests.get'), so a request URL reads a request exactly
// as /api/v1 does, for the same caller:
// - JSON is the body of the /api/v1 read, byte for byte, as agents read it;
// - markdown renders the same request and thread through the one renderer,
//   with every string Tiehall did not generate fenced with its origin as the
//   reader's teams make it;
// - HTML is the web UI's request page, which the app renders once the proxy
//   has let the call through, with the headers the proxy gives it.
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
//
// Every answer sends Vary: Accept, Authorization, Cache-Control: private,
// no-store and an ETag: a JSON body's is strong, from its bytes; markdown's
// and the page's are weak, from the request as the caller reads it, since
// each markdown answer fences with a nonce of its own and the page's forms
// carry the caller's own tokens; a refusal's and a redirect's are from what
// they answer. A read of the web session may renew it, and every answer then
// carries the cookie that renews it, the page's included (sign-in: Signing out
// and ending sessions; github-layer-hardening: design.md, Technical decisions:
// T4).

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
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

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

  return async function requestUrl(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const url = new URL(request.url);
    const path = requestUrlOf(url.pathname);
    if (path === undefined) return undefined;
    const representation = negotiate(request.headers.get("accept"), path.suffix);
    const head = request.method === "HEAD";
    const renewal = new Headers();
    const answer = (response: Response): RequestUrlAnswer => ({ response: withSessionCookies(response, renewal) });
    try {
      const caller = await callerOf(request, representation, renewal);
      if (caller === undefined) {
        // A browser signs in and comes back; an agent is told what reads a request for it.
        if (representation === "html") return answer(redirect(303, new URL(`${SIGN_IN_PATH}?return=${encodeURIComponent(url.pathname)}`, options.url)));
        throw new Refusal(
          "unauthenticated",
          "A request URL answers only members of this install. Read the request with `tiehall get <url>`, once `tiehall login` has signed you in, or with the MCP tool get_request; or send your access token in the Authorization header.",
          { challenge: { scope: ["requests:read"] } },
        );
      }
      const read = (await options.execute("requests.get", caller, { key: path.key }, { readOnly: true })) as RequestWithThreadJson;
      if (representation === "html") {
        const headers = new Headers({ ...URL_HEADERS, etag: requestEtag("html", caller, JSON.stringify(read)) });
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
      return answer(refused(representation === "html", problem, { href: url.pathname, text: "Open the page again" }, head));
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
