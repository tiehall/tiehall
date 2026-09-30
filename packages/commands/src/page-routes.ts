import { SIGN_IN_CALLBACK_PATH } from "./github-manifest.ts";
import { namesHtml, TO_SIGN_IN, type WayOn } from "./html.ts";
import { requestUrlNegotiatesHtml } from "./negotiation.ts";
import { HEALTH_PATH, isApiCall, SETUP_PATH } from "./setup-gate.ts";
import { SIGN_IN_PATH, SIGN_OUT_PATH } from "./sign-in.ts";

// The page routes, for an answer given before any route sees the call, such
// as the web role's request guard's 413 for a body over the limit and its 503
// while the role shuts down (public-api: One error model for Tiehall's own
// refusals; github-layer-hardening: design.md, Decisions this change rests on:
// D50 (7); Technical decisions: T5). The routes that serve the web UI's pages,
// the setup screen, the review pages and confirmations under /confirm/…, and
// GitHub's return to either sign-in callback answer a browser's refusal with
// a page (html.ts): every path but an API call, as the setup gate names them
// (/api, /mcp, /.well-known, /webhooks and /schemas), and /healthz, with
// GitHub's return to the sign-in callback, which lies under /api. The consent
// screen, the device approval page and request URLs are among them; intake
// pages join when they are built. A call negotiates HTML on a request URL as
// its own negotiation decides (negotiation.ts), so a call without an Accept
// header, or one that accepts any type, gets a page there, while a call to
// its .md or .json form gets the problem; on every other page route, a call
// negotiates HTML when its Accept header names text/html, as browsers send
// (pageRouteNegotiatesHtml). The page's link leads on as the routes' own refusals do: for the sign-in page and
// GitHub's return to the sign-in callback, to the sign-in page; for the
// setup screen and its own sign-in, back to the setup screen; for the sign-out
// form, back to the home page, whose form it is; and for every other page, to
// the page that was asked for, at the path and query the call named, or back to
// the page whose form was refused. A form's call does not always name that
// page: a review page's form posts to /confirm/<command> without the review
// page's query, which holds its input. So a form leads back to the page the
// browser posted it from, as its Referer names it, when the caller finds that
// on the install and it is a page route, and to the form's own target
// otherwise. The link is a path on the install, and never leads to another
// host.

/** Where a refusal of the sign-out form leads a browser on: back to the home page, whose form it is. */
const TO_HOME: WayOn = { href: "/", text: "Back to Tiehall's home page" };
/** Where a refusal of the setup screen or its sign-in leads a browser on: back to the setup screen. */
const TO_SETUP: WayOn = { href: SETUP_PATH, text: "Back to the setup screen" };

/** Whether a path is this one or lies under it, as /setup/github does under /setup. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where a refusal of a call with this method and request target (its path and
 * query) leads a browser on, when the call is to a page route; undefined for
 * every other call, whose refusal is always the problem. For a form's call,
 * `referrer` is the page the browser posted the form from, as its Referer
 * header names it, which the caller gives only when it lies on the install.
 */
export function wayOnOfPageRoute(method: string, target: string, referrer?: string): WayOn | undefined {
  let url: URL;
  try {
    url = new URL(target, "http://localhost");
  } catch {
    url = new URL("/", "http://localhost");
  }
  const { pathname, search } = url;
  if (pathname === SIGN_IN_CALLBACK_PATH || pathname === SIGN_IN_PATH) return TO_SIGN_IN;
  if (pathname === HEALTH_PATH || isApiCall(pathname)) return undefined;
  // The setup screen's own sign-in, and GitHub's return to it, lie under /setup.
  if (under(pathname, SETUP_PATH)) return TO_SETUP;
  if (pathname === SIGN_OUT_PATH) return TO_HOME;
  // One slash first, so the link is a path on the install and never names another host.
  const href = `/${pathname.replace(/^[/\\]+/, "")}${search}`;
  if (method === "GET" || method === "HEAD") return { href, text: "Open the page again" };
  return { href: postedFrom(referrer) ?? href, text: "Back to the page" };
}

/** The path and query on the install of the page a form was posted from, when its Referer names a page route; else undefined. */
function postedFrom(referrer: string | undefined): string | undefined {
  if (referrer === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return undefined;
  }
  return wayOnOfPageRoute("GET", `${url.pathname}${url.search}`)?.href;
}

/**
 * Whether a refusal of a call to this page route, a path and query, with this
 * Accept header is a page: on a request URL when the call negotiates HTML
 * there, and on every other page route when its Accept header names
 * text/html.
 */
export function pageRouteNegotiatesHtml(target: string, accept: string | null | undefined): boolean {
  return requestUrlNegotiatesHtml(target, accept) ?? namesHtml(accept);
}
