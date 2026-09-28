import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { SIGN_IN_PATH, SIGN_OUT_PATH } from "./sign-in.ts";
import { csrfTokenFor } from "./web-writes.ts";

// The home page at / (sign-in: GitHub is the only way to sign in; sign-in:
// Signing out and ending sessions). A person who is not signed in is sent to
// the sign-in page, which offers sign-in with GitHub only. A signed-in member
// gets the web UI, with the sign-out form, which carries the session's CSRF
// token, as every web UI write does. A browser whose session a removal ended
// gets 403 removed-member and no data. The page is plain HTML: no script, no
// style from anywhere, no framing, and forms that post only to the install.

export interface HomeRouteOptions {
  /** The web session the request's cookie names; undefined when nobody is signed in, a refusal for an ended session. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: () => string;
  logger?: Logger;
}

export type HomeRoute = (request: Request) => Promise<Response>;

export function createHomeRoute(options: HomeRouteOptions): HomeRoute {
  const logger = options.logger ?? createLogger();
  return async function home(request) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request);
      if (caller === undefined) return new Response(null, { status: 303, headers: { location: SIGN_IN_PATH, "cache-control": "no-store" } });
      const csrf = csrfTokenFor(options.secret(), caller.sessionId);
      return new Response(
        htmlPage(
          "Tiehall",
          `      <h1>Tiehall</h1>
      <p>You are signed in.</p>
      <form method="post" action="${SIGN_OUT_PATH}">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button type="submit">Sign out</button>
      </form>`,
        ),
        { headers: PAGE_HEADERS },
      );
    } catch (error) {
      if (error instanceof Refusal) return problem(httpProblem(error));
      logger.error("home: the home page failed", { error });
      return problem(internalErrorProblem());
    }
  };
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal cannot be framed either.
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] } });
}
