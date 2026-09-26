import { createHmac, timingSafeEqual } from "node:crypto";
import { Refusal } from "@tiehall/core";

// The checks every web UI write passes (agent-safety: One confirmation
// approves one action; agent-safety: Actions that need the confirmation step;
// design.md, Self-hosting decisions: S7). An agent that drives a browser, or
// another site the person has open, could send the web UI's requests with the
// session cookie alone, so a write, a rejection or a confirmation among them,
// must also carry:
// - the CSRF token of the user's web session, which a page of the install puts
//   in its forms: an HMAC of the session's id under the install's auth secret,
//   which no other site can read or compute;
// - an Origin equal to the install's URL, TIEHALL_URL;
// - Sec-Fetch-Site: same-origin, which the browser sets and no page can.
// A write that fails any of them gets 403 and changes nothing: as a missing
// confirmation (confirmation-required) when the action needs the
// confirmation step, and as an action the caller may not take (forbidden)
// otherwise. A page's GET is no write: it runs in a read-only transaction.

/** What a web UI write carries besides its session cookie. */
export interface WebWriteRequest {
  /** The Origin header. */
  origin: string | null;
  /** The Sec-Fetch-Site header. */
  fetchSite: string | null;
  /** The CSRF token the page's form sent. */
  csrfToken: string | null;
}

/** The CSRF token of a web session: its id signed with the install's auth secret. */
export function csrfTokenFor(secret: string, sessionId: string): string {
  const key = createHmac("sha256", secret).update("tiehall csrf token v1").digest();
  return createHmac("sha256", key).update(sessionId, "utf8").digest("base64url");
}

/** What is wrong with a web UI write's request, as a sentence; undefined when it passes every check. */
export function webWriteProblem(request: WebWriteRequest, check: { url: string; secret: string; sessionId: string }): string | undefined {
  if (originOf(request.origin) !== check.url) return "it was not sent from a page of the install: its Origin is not TIEHALL_URL";
  if (request.fetchSite !== "same-origin") return "the browser does not say it was sent from the install's own pages (Sec-Fetch-Site)";
  const expected = Buffer.from(csrfTokenFor(check.secret, check.sessionId));
  const given = Buffer.from(request.csrfToken ?? "");
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
    return "it does not carry the CSRF token of the signed-in session";
  }
  return undefined;
}

/**
 * Refuses a web UI write that fails a check with 403: as a missing
 * confirmation for an action that needs the confirmation step, and as a
 * forbidden action otherwise.
 */
export function assertWebWrite(
  request: WebWriteRequest,
  check: { url: string; secret: string; sessionId: string; confirm: boolean },
): void {
  const problem = webWriteProblem(request, check);
  if (problem === undefined) return;
  throw new Refusal(check.confirm ? "confirmation-required" : "forbidden", `This write is refused: ${problem}.`);
}

/** The origin an Origin header names, in the form TIEHALL_URL is kept in; undefined for none or "null". */
function originOf(value: string | null): string | undefined {
  if (value === null || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
