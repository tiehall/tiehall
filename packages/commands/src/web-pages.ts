import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { answerRefusal, escapeHtml, PAGE_HEADERS, TO_SIGN_IN, type WayOn } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { SIGN_IN_PATH } from "./sign-in.ts";
import { assertWebWrite, csrfTokenFor } from "./web-writes.ts";

// What the web UI's plain pages share, such as the members page and the admin
// pages for invites, teams and the sign-in policy (teams-and-roles: What
// admins and members may do; agent-safety: One confirmation approves one
// action; design.md, Self-hosting decisions: S7). A page's GET runs its reads
// through execute(), as the signed-in user's web session, in a read-only
// transaction, so it changes nothing and a member gets the same 403 for an
// admin read as anywhere else. A form's POST first passes the checks every web
// UI write passes (the session's CSRF token, an Origin equal to TIEHALL_URL and
// Sec-Fetch-Site: same-origin), then runs its operation through execute() and
// leads back to the page. An action that needs the confirmation step is never
// posted here: the page links to its review page instead. A browser without a
// session is sent to sign in first and comes back to the page (D28 #66); a
// POST without one gets 401. Every answer runs no script, loads nothing and
// cannot be framed; a refusal is a page for a browser, which leads back to
// the page, or to sign in, and an RFC 9457 problem for every other client
// (public-api: One error model for Tiehall's own refusals; html.ts), and any
// other failure is a 500 that says nothing about it.

export interface PageRouteOptions {
  execute: Execute;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
  /** The install's URL (TIEHALL_URL), as its origin, which a write's Origin must equal. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: () => string;
  logger?: Logger;
}

export type PageRoute = (request: Request) => Promise<Response>;

/** How a page runs operations, as the signed-in user's web session. */
export interface PageCalls {
  /** The signed-in user. */
  caller: WebSessionCaller;
  /** The session's CSRF token, which the page's forms carry. */
  csrf: string;
  /** Runs a read in a read-only transaction. */
  read<Output>(commandId: string, input: unknown): Promise<Output>;
  /** Runs a write, for a form that passed the web UI's write checks. */
  write(commandId: string, input: unknown): Promise<unknown>;
}

export interface PageHandlers {
  /** The page's path, which a browser without a session comes back to once it has signed in. */
  path: string;
  /** Used in the log when the page fails. */
  name: string;
  /** Answers a GET. */
  get(query: URLSearchParams, calls: PageCalls): Promise<Response>;
  /** Answers a form's POST, once it passed the write checks; a page without forms has none, and a POST then gets 404. */
  post?(form: URLSearchParams, calls: PageCalls): Promise<Response>;
}

/** A page of the web UI at a fixed path, with its GET and, if it has forms, its POST. */
export function createPageRoute(options: PageRouteOptions, handlers: PageHandlers): PageRoute {
  const logger = options.logger ?? createLogger();
  return async function pageRoute(request) {
    try {
      const post = handlers.post;
      const isGet = request.method === "GET" || request.method === "HEAD";
      if (!isGet && (request.method !== "POST" || post === undefined)) throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request);
      if (caller === undefined) {
        if (isGet) return signInFirst(handlers.path);
        throw new Refusal("unauthenticated", "Sign in to Tiehall to do this.");
      }
      const origin = originOf(request);
      const calls: PageCalls = {
        caller,
        csrf: csrfTokenFor(options.secret(), caller.sessionId),
        read: async (commandId, input) => (await options.execute(commandId, caller, input, { readOnly: true })) as never,
        write: (commandId, input) => options.execute(commandId, caller, input, { origin }),
      };
      if (isGet) return await handlers.get(new URL(request.url).searchParams, calls);
      const form = new URLSearchParams(await request.text());
      assertWebWrite(
        { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
        { url: options.url, secret: options.secret(), sessionId: caller.sessionId, confirm: false },
      );
      return await post!(form, calls);
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), wayOnFrom(error, handlers));
      logger.error(`${handlers.name}: the page failed`, { error });
      return problem(internalErrorProblem());
    }
  };
}

/** Where a page's refusal leads a browser on: to sign in when it is not signed in, and otherwise back to the page, whose form it was. */
function wayOnFrom(refusal: Refusal, handlers: Pick<PageHandlers, "path" | "name">): WayOn {
  return refusal.reason === "unauthenticated" ? TO_SIGN_IN : { href: handlers.path, text: `Back to the ${handlers.name} page` };
}

/** The headers every answer carries, so that no other site can frame it. */
function frameless(): Record<string, string> {
  return { "content-security-policy": PAGE_HEADERS["content-security-policy"] };
}

function problem({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...frameless() } });
}

/** A page's HTML. */
export function htmlAnswer(html: string): Response {
  return new Response(html, { headers: PAGE_HEADERS });
}

/** Leads the browser to another page, such as back to the page after its form's write, or on to a review page. */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...frameless() } });
}

/** Sends a browser without a session to the sign-in page, which brings it back to this path; the answer holds nothing of the page. */
function signInFirst(path: string): Response {
  return seeOther(`${SIGN_IN_PATH}?return=${encodeURIComponent(path)}`);
}

/** The client address and user agent of a form's POST, which a security event keeps apart from the event. */
function originOf(request: Request): NonNullable<ExecuteOptions["origin"]> {
  const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;
  return { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) };
}

/** A form that posts to a page: its fields, the session's CSRF token and its one button. */
export function postForm(action: string, fields: Readonly<Record<string, string>>, csrf: string, button: string, indent = "      "): string {
  return [
    `${indent}<form method="post" action="${escapeHtml(action)}">`,
    ...Object.entries(fields).map(([name, value]) => `${indent}  <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`),
    `${indent}  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    `${indent}  <button type="submit">${escapeHtml(button)}</button>`,
    `${indent}</form>`,
  ].join("\n");
}

/** A link with its text. */
export function link(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}
