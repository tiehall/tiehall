import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import { MEMBERS_PATH } from "./admin-pages.ts";
import type { WebSessionCaller } from "./caller.ts";
import { answerRefusal, escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { renewingSession } from "./session-renewal.ts";
import { SIGN_IN_PATH, SIGN_OUT_PATH } from "./sign-in.ts";
import { csrfTokenFor } from "./web-writes.ts";

// The home page at / (sign-in: GitHub is the only way to sign in; sign-in:
// Signing out and ending sessions). A person who is not signed in is sent to
// the sign-in page, which offers sign-in with GitHub only. A signed-in member
// gets the web UI, with a link to the members page, from which an admin
// reaches the admin pages, and the sign-out form, which carries the session's
// CSRF token, as every web UI write does. A browser whose session a removal ended,
// or whose user is not a member, gets 403 removed-member and no data, as a page for a browser and a problem
// for every other client (html.ts). The page is plain HTML: no script, no
// style from anywhere, no framing, and forms that post only to the install.
// Every answer carries the cookie that renews the session it read, when the
// read renewed it (sign-in: Signing out and ending sessions;
// session-renewal.ts).

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
      return new Response(
        htmlPage(
          "Tiehall",
          `      <h1>Tiehall</h1>
      <p>You are signed in.</p>
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
