import { confirmProposal, rejectProposal, undoCommitment } from "@tiehall/catalog";
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
//
// A proposal's confirm page is /confirm/{proposal} (requests: The proposal's
// confirm page; design.md, Self-hosting decisions: S15): the review page of
// proposals.confirm for that proposal, whose nonce is bound to what the
// proposal proposes and the request it applies to. Besides its Confirm form, it
// holds a Reject form, which posts `action=reject` with the session's CSRF
// token and no nonce: a rejection needs no confirmation step, but passes the
// same write checks, and runs proposals.reject (agent-safety: Actions that need
// the confirmation step). Who may confirm or reject the proposal, and when, the
// commands decide: 403 or 409. /confirm/{proposal}/undo is the undo page that
// the receipt of a commitment that took effect links: the review page of
// proposals.undo for that proposal (requests: The undo window for reversible
// commitments).

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
    const { proposal, undo } = proposalPageOf(url.pathname);
    const commandId = proposal === undefined ? commandIdOf(url.pathname) : undo ? undoCommitment.id : confirmProposal.id;
    try {
      if (request.method === "POST") return await apply(request, commandId, proposal, undo);
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await signedIn(request);
      const { input, refusal } = proposal === undefined ? parseInput(url.searchParams.get("input")) : { input: { proposal }, refusal: undefined };
      const reviewed = await options.step.review(commandId, caller, input, refusal);
      const csrf = csrfTokenFor(secret(), caller.sessionId);
      const path = proposal === undefined ? `${CONFIRM_PATH}${commandId}` : `${CONFIRM_PATH}${proposal}${undo ? "/undo" : ""}`;
      return page(reviewPage(path, reviewed.review, canonicalJson(reviewed.input), reviewed.nonce, csrf, proposal !== undefined && !undo));
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

  /** Applies the action the review page's form posted: the action it reviewed, or, on a proposal's page, a rejection. */
  async function apply(request: Request, commandId: string, proposal: string | undefined, undo: boolean): Promise<Response> {
    const caller = await signedIn(request);
    if (!options.step.needsConfirmation(commandId)) throw new Refusal("route-not-found", "There is no review page for this action.");
    const form = new URLSearchParams(await request.text());
    const rejecting = proposal !== undefined && !undo && form.get("action") === "reject";
    assertWebWrite(
      { origin: request.headers.get("origin"), fetchSite: request.headers.get("sec-fetch-site"), csrfToken: form.get("csrf") },
      { url: options.write.url, secret: secret(), sessionId: caller.sessionId, confirm: !rejecting },
    );
    const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const origin = { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) };
    if (rejecting) {
      // A rejection ends the proposal without any effect, so it needs no nonce.
      await options.write.execute(rejectProposal.id, caller, { proposal }, { origin });
      return page(htmlPage("Rejected", "      <h1>Rejected</h1>\n      <p>The proposal you reviewed is rejected; it will not take effect.</p>"));
    }
    // A proposal's page confirms the proposal its path names, whatever else the form sends.
    const { input, refusal } = proposal === undefined ? parseInput(form.get("input")) : { input: { proposal }, refusal: undefined };
    const nonce = form.get("nonce");
    await options.write.execute(commandId, caller, input, {
      ...(refusal === undefined ? {} : { refusal }),
      ...(nonce === null || nonce === "" ? {} : { confirmation: { nonce } }),
      origin,
    });
    return page(htmlPage("Confirmed", "      <h1>Confirmed</h1>\n      <p>The action you reviewed is applied.</p>"));
  }
}

const PROPOSAL_PAGE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/undo)?$/;

/**
 * The proposal a page's path names: /confirm/{proposal}, its confirm page, or
 * /confirm/{proposal}/undo, the undo page its receipt links; none for any
 * other path.
 */
function proposalPageOf(pathname: string): { proposal?: string; undo: boolean } {
  if (!pathname.startsWith(CONFIRM_PATH)) return { undo: false };
  const match = PROPOSAL_PAGE.exec(pathname.slice(CONFIRM_PATH.length).toLowerCase());
  return match === null ? { undo: false } : { proposal: match[1] ?? "", undo: match[2] !== undefined };
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

/** The review page: what will happen, and the form that applies it, with a form that rejects it on a proposal's page. */
function reviewPage(path: string, review: Review, input: string, nonce: string, csrf: string, rejectable: boolean): string {
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
      `      <form method="post" action="${escapeHtml(path)}">`,
      `        <input type="hidden" name="input" value="${escapeHtml(input)}">`,
      `        <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      `        <button type="submit">Confirm</button>`,
      `      </form>`,
      ...(rejectable
        ? [
            `      <form method="post" action="${escapeHtml(path)}">`,
            `        <input type="hidden" name="action" value="reject">`,
            `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
            `        <button type="submit">Reject</button>`,
            `      </form>`,
          ]
        : []),
    ].join("\n"),
  );
}
