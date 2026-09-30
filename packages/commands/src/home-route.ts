import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { MEMBERS_PATH } from "./admin-pages.ts";
import { EMAIL_SETTINGS_PATH } from "./email-settings-page.ts";
import { INBOX_PATH } from "./inbox-page.ts";
import { NEW_REQUEST_PATH } from "./new-request.ts";
import { REQUEST_LISTS_PATH } from "./request-lists.ts";
import type { Banner } from "./admin-alerts.ts";
import { bannersSection } from "./admin-page.ts";
import type { WebSessionCaller } from "./caller.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { SIGN_IN_PATH, SIGN_OUT_PATH } from "./sign-in.ts";
import { csrfTokenFor } from "./web-writes.ts";

// The home page at / (sign-in: GitHub is the only way to sign in; sign-in:
// Signing out and ending sessions). A person who is not signed in is sent to
// the sign-in page, which offers sign-in with GitHub only. A signed-in member
// gets the web UI, with links to their web inbox (requester-loop: The web
// inbox) and their email settings, the request lists (requests: Every member
// sees every request), the form that opens a request and the members page,
// from which an admin reaches the admin pages, and the sign-out form, which
// carries the session's CSRF token, as every web UI write does. A browser
// whose session a removal ended, or whose user is not a member, gets 403
// removed-member and no data, as a page for a browser and a problem for every
// other client (html.ts). The page
// is plain HTML: no script, no style from anywhere, no framing, and forms that
// post only to the install. Every answer carries the cookie that renews the
// session it read, when the read renewed it (sign-in: Signing out and ending
// sessions; session-renewal.ts). Above the links it shows the banners the
// signed-in member may act on, such as a problem with an integration to an
// admin (tracker-mirrors: Broken integrations are surfaced; admin-alerts.ts).

export interface HomeRouteOptions {
  /**
   * The web session the request's cookie names; undefined when nobody is
   * signed in, a refusal for an ended session. The read may renew the
   * session, and adds to `renewal` the cookies the answer carries
   * (session-renewal.ts).
   */
  session(request: Request, renewal?: Headers): Promise<WebSessionCaller | undefined>;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: () => string;
  /** The banners the web UI shows this member, read through execute(); the page shows none without it. */
  banners?: (caller: WebSessionCaller) => Promise<readonly Banner[]>;
  logger?: Logger;
}

export type HomeRoute = (request: Request) => Promise<Response>;

export function createHomeRoute(options: HomeRouteOptions): HomeRoute {
  const logger = options.logger ?? createLogger();
  return (request) => renewingSession((renewal) => home(request, renewal));

  async function home(request: Request, renewal: Headers): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request, renewal);
      if (caller === undefined) return new Response(null, { status: 303, headers: { location: SIGN_IN_PATH, "cache-control": "no-store" } });
      const csrf = csrfTokenFor(options.secret(), caller.sessionId);
      const banners = options.banners === undefined ? [] : await options.banners(caller);
      return new Response(
        htmlPage(
          "Tiehall",
          `      <h1>Tiehall</h1>
${bannersSection(banners).map((line) => `${line}\n`).join("")}      <p>You are signed in.</p>
      <p><a href="${INBOX_PATH}">Inbox</a></p>
      <p><a href="${EMAIL_SETTINGS_PATH}">Email settings</a></p>
      <p><a href="${REQUEST_LISTS_PATH}">Requests</a></p>
      <p><a href="${NEW_REQUEST_PATH}">Open a request</a></p>
      <p><a href="${MEMBERS_PATH}">Members</a></p>
      <form method="post" action="${SIGN_OUT_PATH}">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button type="submit">Sign out</button>
      </form>`,
        ),
        { headers: PAGE_HEADERS },
      );
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), { href: "/", text: "Go to Tiehall's home page" });
      logger.error("home: the home page failed", { error });
      return problem(internalErrorProblem());
    }
  }
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] } });
}
