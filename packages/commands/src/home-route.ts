import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { INBOX_PATH } from "./inbox-page.ts";
import { NEW_REQUEST_PATH } from "./new-request.ts";
import { REQUEST_LISTS_PATH } from "./request-lists.ts";
import type { Banner } from "./admin-alerts.ts";
import { bannersSection } from "./admin-page.ts";
import type { WebSessionCaller } from "./caller.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS, wayOnFor } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { HALL_PATH, waitingSentence, type ShellMember } from "./shell.ts";
import { SIGN_IN_PATH } from "./sign-in.ts";
import { csrfTokenFor } from "./web-writes.ts";

// The home page at / (sign-in: GitHub is the only way to sign in; sign-in:
// Signing out and ending sessions; web-ui: The page shell and its navigation).
// A person who is not signed in is sent to the sign-in page, which offers
// sign-in with GitHub only. A signed-in member gets the web UI in the app
// shell, whose navigation and menu link their web inbox (requester-loop: The
// web inbox), their email settings, the request lists (requests: Every member
// sees every request), the form that opens a request and the members page,
// and, for an admin, the admin pages, and hold the sign-out form, which
// carries the session's CSRF token, as every web UI write does; the shell's
// read, web.shell, comes first. A browser whose session a removal ended, or
// whose user is not a member, gets 403 removed-member and no data, as a page
// for a browser and a problem for every other client (html.ts). The page is
// plain HTML: no script, styles and images from the install only, no
// framing, and forms that post only to the install. Every answer carries the
// cookie that renews the session it read, when the read renewed it (sign-in:
// Signing out and ending sessions; session-renewal.ts). It shows the banners
// the signed-in member may act on, such as a problem with an integration to an
// admin (tracker-mirrors: Broken integrations are surfaced; admin-alerts.ts),
// or a failed mirror job of their team's request, whose Retry button is a
// form that carries the session's CSRF token (tracker-mirrors: Failed mirror
// jobs are shown with a Retry button; mirror-failures.ts), then four cards.

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
  /** What the app shell shows of this member, web.shell read through execute(), which the page reads first. */
  shell: (caller: WebSessionCaller) => Promise<ShellMember>;
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
      const member = await options.shell(caller);
      const banners = options.banners === undefined ? [] : await options.banners(caller);
      return new Response(htmlPage("Tiehall", homeMain(member, bannersSection(banners, { csrf, back: "/" })), { form: "app", member, path: "/", csrf }), { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof Refusal) return answerRefusal(request, httpProblem(error), wayOnFor(error.reason, { href: "/", text: "Go to Tiehall's home page" }));
      logger.error("home: the home page failed", { error });
      return problem(internalErrorProblem());
    }
  }
}

/**
 * The home page's main content: the banners the member may act on, then four
 * cards: what waits for the member, with the count and the way to the inbox;
 * the requests; the live hall; and a new request (web-ui: The page shell and
 * its navigation; design.md, Design: The page shell and navigation; D57 (4)).
 * It reads nothing the shell and the banners do not read already.
 */
function homeMain(member: ShellMember, banners: readonly string[]): string {
  const lamp = member.waiting > 0 ? '<span class="lamp needs-info blink" aria-hidden="true"></span>' : "";
  const card = (title: string, text: string, href: string, button: string, primary = false) =>
    [
      '        <li class="card">',
      `          <h2>${title}</h2>`,
      `          <p>${escapeHtml(text)}</p>`,
      `          <a class="button${primary ? "" : " secondary"}" href="${href}">${escapeHtml(button)}</a>`,
      "        </li>",
    ].join("\n");
  return [
    `      <h1>${escapeHtml(`Welcome, ${member.login}`)}</h1>`,
    '      <p class="muted">You are signed in.</p>',
    ...banners,
    '      <ul class="cards">',
    card(`${lamp}Waiting for you`, waitingSentence(member.waiting), INBOX_PATH, "Open the inbox", member.waiting > 0),
    card("Requests", "The requests addressed to your teams, the ones you opened, and every other.", REQUEST_LISTS_PATH, "See the requests"),
    card("Live hall", "Watch requests move between the teams, and the people and agents at work on them.", HALL_PATH, "Open the live hall"),
    card("New request", "Ask another team for something: their agents read exactly what you write.", NEW_REQUEST_PATH, "Open a request"),
    "      </ul>",
  ].join("\n");
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] } });
}
