import { canonicalJson, httpProblem, internalErrorProblem, quotePreamble, Refusal, type HttpProblem, type Review } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { ConfirmationStep } from "./confirmation-step.ts";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";

// The review pages of the confirmation step, under /confirm/<command id>
// (agent-safety: The review page of the confirmation step; design.md,
// Self-hosting decisions: S7 and S15). A page of the web UI that starts an
// action that needs the confirmation step sends the person here, with the
// action's input as JSON in the `input` query parameter. A GET:
// - renders what the action will do, in Tiehall's own words, from the
//   command's review, with every quote of text Tiehall did not write escaped
//   and fenced under a preamble that names where it came from;
// - holds a form that posts the action's parsed input, in canonical JSON, back
//   to the same path, with the page's confirmation nonce;
// - changes no state: the review runs in a read-only transaction.
// Every answer, refusals included, sends a Content-Security-Policy with
// frame-ancestors 'none', so no other site can frame the page and trick a
// click; the pages run no script and load nothing. A refusal is an RFC 9457
// problem (public-api: One error model for Tiehall's own refusals): 401
// without a signed-in user, 404 for an action with no review page, 400 for
// input that fails its schema or is not JSON.

export interface ConfirmRouteOptions {
  step: ConfirmationStep;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
  logger?: Logger;
}

export type ConfirmRoute = (request: Request) => Promise<Response>;

/** Where the review pages live; a page's path names its command, such as /confirm/tokens.create. */
export const CONFIRM_PATH = "/confirm/";

export function createConfirmRoute(options: ConfirmRouteOptions): ConfirmRoute {
  const logger = options.logger ?? createLogger();
  return async function confirm(request) {
    const url = new URL(request.url);
    const commandId = commandIdOf(url.pathname);
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request);
      if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to confirm an action.");
      const input = parseInput(url.searchParams.get("input"));
      const reviewed = await options.step.review(commandId, caller, input);
      return page(reviewPage(reviewed.commandId, reviewed.review, canonicalJson(reviewed.input), reviewed.nonce));
    } catch (error) {
      if (error instanceof Refusal) return problem(httpProblem(error));
      logger.error("confirm: the review page failed", { operationId: commandId, error });
      return problem(internalErrorProblem());
    }
  };
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

/** The action's input from its JSON text. */
function parseInput(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    throw new Refusal("invalid-input", "The input of a review page is JSON, in its input query parameter.");
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
function reviewPage(commandId: string, review: Review, input: string, nonce: string): string {
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
      `        <button type="submit">Confirm</button>`,
      `      </form>`,
    ].join("\n"),
  );
}
