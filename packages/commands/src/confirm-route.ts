import { canonicalJson, httpProblem, internalErrorProblem, quotePreamble, Refusal, type HttpProblem, type Review } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { ConfirmationStep } from "./confirmation-step.ts";
import type { Execute } from "./execute.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";
import { assertWebWrite, csrfTokenFor } from "./web-writes.ts";

// The review pages of the confirmation step, under /confirm/<command id>
// (agent-safety: The review page of the confirmation step; design.md,
// Self-hosting decisions: S7 and S15). A page of the web UI that starts an
// action that needs the confirmation step sends the person here, with the
// action's input as JSON in the `input` query parameter. A GET:
// - renders what the action will do, in Tiehall's own words, from the
//   command's review, with every quote of text Tiehall did not write escaped
//   and fenced under a preamble that names where it came from;
// - holds a form that posts the action's parsed input, in canonical JSON, back
//   to the same path, with the page's confirmation nonce and the session's
//   CSRF token;
// - changes no state: the review runs in a read-only transaction.
// The POST applies the action (agent-safety: One confirmation approves one
// action): only for the signed-in user, only once it passes the checks every
// web UI write passes (the session's CSRF token, an Origin equal to
// TIEHALL_URL and Sec-Fetch-Site: same-origin), and only through execute(),
// which checks and consumes the nonce in the action's own transaction. A
// request that fails a check, or carries no valid nonce, gets 403 and changes
// nothing, so the session and the CSRF token alone never apply an action.
// Every answer, refusals included, sends a Content-Security-Policy with
// frame-ancestors 'none', so no other site can frame the page and trick a
// click; the pages run no script and load nothing. A refusal is an RFC 9457
// problem (public-api: One error model for Tiehall's own refusals): 401
// without a signed-in user, 404 for an action with no review page, 403
// removed-member for a user who is no longer a member, whatever they send, 400
// for input that fails its schema or is not JSON, 403 for a failed check or a
// missing or invalid nonce.

export interface ConfirmRouteOptions {
  step: ConfirmationStep;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
  /** How a confirmation is applied and checked. */
  write: {
    execute: Execute;
    /** The install's URL (TIEHALL_URL), as its origin, which a confirmation's Origin must equal. */
    url: string;
    /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
    secret: string | (() => string);
  };
  logger?: Logger;
}

export type ConfirmRoute = (request: Request) => Promise<Response>;

/** Where the review pages live; a page's path names its command, such as /confirm/tokens.create. */
export const CONFIRM_PATH = "/confirm/";

export function createConfirmRoute(options: ConfirmRouteOptions): ConfirmRoute {
  const logger = options.logger ?? createLogger();
  const secret = () => (typeof options.write.secret === "string" ? options.write.secret : options.write.secret());
  return async function confirm(request) {
    const url = new URL(request.url);
    const commandId = commandIdOf(url.pathname);
    try {
      if (request.method === "POST") return await apply(request, commandId);
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await signedIn(request);
      const { input, refusal } = parseInput(url.searchParams.get("input"));
      const reviewed = await options.step.review(commandId, caller, input, refusal);
      const csrf = csrfTokenFor(secret(), caller.sessionId);
      return page(reviewPage(reviewed.commandId, reviewed.review, canonicalJson(reviewed.input), reviewed.nonce, csrf));
    } catch (error) {
      if (error instanceof Refusal) return problem(httpProblem(error));
      logger.error("confirm: the review page failed", { operationId: commandId, error });
      return problem(internalErrorProblem());
    }
  };

  async function signedIn(request: Request): Promise<WebSessionCaller> {
    const caller = await options.session(request);
    if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to confirm an action.");
    return caller;
  }

  /** Applies the action the review page's form posted. */
  async function apply(request: Request, commandId: string): Promise<Response> {
    const caller = await signedIn(request);
    if (!options.step.needsConfirmation(commandId)) throw new Refusal("route-not-found", "There is no review page for this action.");
    const form = new URLSearchParams(await request.text());
    assertWebWrite(
      { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
      { url: options.write.url, secret: secret(), sessionId: caller.sessionId, confirm: true },
    );
    const { input, refusal } = parseInput(form.get("input"));
    const nonce = form.get("nonce");
    const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    await options.write.execute(commandId, caller, input, {
      ...(refusal === undefined ? {} : { refusal }),
      ...(nonce === null || nonce === "" ? {} : { confirmation: { nonce } }),
      origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) },
    });
    return page(htmlPage("Confirmed", "      <h1>Confirmed</h1>\n      <p>The action you reviewed is applied.</p>"));
  }
}

/** The command a review page's path names; empty, which names none, for any other path. */
function commandIdOf(pathname: string): string {
  if (!pathname.startsWith(CONFIRM_PATH)) return "";
  try {
    return decodeURIComponent(pathname.slice(CONFIRM_PATH.length));
  } catch {
    return "";
  }
}

/**
 * The action's input from its JSON text, or the refusal of text that is not
 * JSON, which the review and execute() give after the membership re-check.
 */
function parseInput(text: string | null): { input: unknown; refusal?: Refusal } {
  try {
    return { input: JSON.parse(text ?? "{}") };
  } catch {
    return { input: {}, refusal: new Refusal("invalid-input", "The input of an action to confirm is JSON.") };
  }
}

function problem({ status, headers, body }: HttpProblem): Response {
  // A refusal on a review page cannot be framed either.
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-security-policy": PAGE_HEADERS["content-security-policy"] },
  });
}

function page(html: string): Response {
  return new Response(html, { headers: PAGE_HEADERS });
}

/** The review page: what will happen, and the form that applies it. */
function reviewPage(commandId: string, review: Review, input: string, nonce: string, csrf: string): string {
  const lines = review.lines.map((line) =>
    "text" in line
      ? `      <p>${escapeHtml(line.text)}</p>`
      : `      <blockquote class="untrusted" data-origin="${escapeHtml(line.origin)}"><p>${escapeHtml(quotePreamble(line.origin))}</p><pre>${escapeHtml(line.quote)}</pre></blockquote>`,
  );
  return htmlPage(
    `Confirm: ${review.title}`,
    [
      `      <h1>${escapeHtml(review.title)}</h1>`,
      ...lines,
      `      <form method="post" action="${escapeHtml(`${CONFIRM_PATH}${commandId}`)}">`,
      `        <input type="hidden" name="input" value="${escapeHtml(input)}">`,
      `        <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      `        <button type="submit">Confirm</button>`,
      `      </form>`,
    ].join("\n"),
  );
}
