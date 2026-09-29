import { SIGN_IN_CALLBACK_PATH } from "./github-manifest.ts";
import { TO_SIGN_IN, type WayOn } from "./html.ts";
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
// GitHub's return to the sign-in callback, which lies under /api. The consent,
// device approval, request URL and intake pages join when they are built. The
// page's link leads on as the routes' own refusals do: for the sign-in page and
// GitHub's return to the sign-in callback, to the sign-in page; for the
// setup screen and its own sign-in, back to the setup screen; for the sign-out
// form, back to the home page, whose form it is; and for every other page, to
// the page that was asked for, or back to the page whose form was refused, at
// the path and query the call named, which never leads to another host.

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
 * every other call, whose refusal is always the problem.
 */
export function wayOnOfPageRoute(method: string, target: string): WayOn | undefined {
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
  return method === "GET" || method === "HEAD" ? { href, text: "Open the page again" } : { href, text: "Back to the page" };
}
