import { NextResponse } from "next/server";
import { setupGate } from "@tiehall/commands/setup";
import { namesHtml } from "@tiehall/commands/html";
import { NEGOTIATED_KEY_HEADER, negotiatedUrlOf, pageContentSecurityPolicy, requestUrlRoute } from "@tiehall/commands/web";
import { servedByRouteHandler } from "./lib/route-handlers.ts";

// Runs before every route (self-host-install: The setup code guards the setup
// screen; design.md, Self-hosting decisions: S3). Until setup is complete, the
// setup gate answers every call but /setup, /healthz and, once the setup
// screen has stored the GitHub App's credentials, with or without a webhook
// secret, /webhooks/github: a page leads to /setup and an API call gets 503
// setup-required. Afterwards every call goes on to its route, except a call to
// a request's URL, /<KEY> with or without .md or .json, or to a team's intake
// page, /<TEAM> with or without them, written plainly or with percent-encoded
// characters, whatever its method, which is negotiated here
// (agent-surfaces: Negotiated request URLs; agent-surfaces: Team intake pages;
// design.md, Technical decisions: T3): markdown, JSON, a redirect or a refusal
// is answered here, and HTML, or a form's post to a request's page, goes on to
// the web UI's page with the headers every answer of a negotiated URL carries,
// and the cookie that renews the session, which a server component cannot
// set. The page's content security policy, whose script nonce is made for each
// answer, goes to Next.js with the call too, which then puts the nonce on the
// page's scripts (agent-safety: The web UI renders no raw HTML and no remote
// images).
//
// A call that goes on to the page names the key it was negotiated as in a
// header of the proxy's own (NEGOTIATED_KEY_HEADER), and the page renders only
// for that key, so nothing reaches the page around the negotiation; the proxy
// takes that header from every other call, so none can name it for itself.
// The page's answer carries the same header, from which the web role gives it
// the headers of every answer of a negotiated URL, which Next.js may have set
// otherwise, such as its Vary and, for a server action's answer, its
// Cache-Control, and which it sends to nobody (negotiatedUrlHeaders).

/**
 * Lets a call that is not negotiated here go on to its route, without the
 * header the proxy names a negotiated key in, and with the policy of the pages
 * Next.js renders, with a nonce made for it, from which Next.js takes the
 * nonce for its scripts (web-ui: The content security policy of each kind of
 * page; design.md, Design: The content security policy of each kind of page;
 * D57 (9)). When the call accepts HTML and no route handler serves its path,
 * the answer carries the policy too, so the page for a path no route serves,
 * and the page shown when rendering one fails, have it. A route handler's
 * answer keeps the policy it gives itself: Next.js would keep the proxy's
 * header over it (lib/route-handlers.ts).
 */
function passOn(request: Request): NextResponse {
  const policy = pageContentSecurityPolicy();
  const headers = new Headers(request.headers);
  headers.delete(NEGOTIATED_KEY_HEADER);
  headers.set("content-security-policy", policy);
  const url = new URL(request.url);
  const routed = servedByRouteHandler(url.pathname);
  // A path of one segment that names no key and no route would reach the page of a key, /[key], whose notFound()
  // Next.js renders only in the browser; led on to a path no route serves, it gets the web app's page for such a path,
  // rendered on the server, in the address the browser asked for.
  const next = !routed && ONE_SEGMENT.test(url.pathname) ? NextResponse.rewrite(new URL(`${url.pathname}${NO_ROUTE}${url.search}`, url), { request: { headers } }) : NextResponse.next({ request: { headers } });
  if (namesHtml(request.headers.get("accept")) && !routed) next.headers.set("content-security-policy", policy);
  return next;
}

/** A path of one segment, such as /no-such-page. */
const ONE_SEGMENT = /^\/[^/]+$/;
/** What a path of one segment that names no key and no route is led on with, to a path no route serves. */
const NO_ROUTE = "/no-route";

/** Lets a negotiated call go on to the page of this key, with the page's content security policy, which Next.js reads its script nonce from. */
function toPage(request: Request, key: string, policy: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  headers.set(NEGOTIATED_KEY_HEADER, key);
  const next = NextResponse.next({ request: { headers } });
  next.headers.set("content-security-policy", policy);
  next.headers.set(NEGOTIATED_KEY_HEADER, key);
  return next;
}

export async function proxy(request: Request): Promise<Response> {
  const gated = await setupGate(process.env)(request);
  if (gated !== undefined) return gated;
  if (negotiatedUrlOf(new URL(request.url).pathname) === undefined) return passOn(request);
  const answer = await requestUrlRoute(process.env)(request);
  if (answer === undefined) return passOn(request);
  if ("response" in answer) return answer.response;
  const next = toPage(request, answer.page.key, answer.page.headers.get("content-security-policy") ?? pageContentSecurityPolicy());
  answer.page.headers.forEach((value, name) => {
    if (name !== "set-cookie") next.headers.set(name, value);
  });
  for (const cookie of answer.page.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}
