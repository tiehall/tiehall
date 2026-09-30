import { claimRequest, isProposalAnswer, postMessage, setRequestStatus } from "@tiehall/catalog";
import { httpProblem, Refusal, type ProblemDetails } from "@tiehall/core";
import type { WebResult } from "./web-commands.ts";

// The actions on the web UI's page of a request (public-api: One definition
// per operation, the same on every surface; requests: Claiming and starting
// work need no proposal; requests: Thread messages and blocking questions;
// design.md, Technical decisions: T3). Each of the page's forms posts to one
// server action, which names what the form does in its `action` field; this
// module turns the form's fields into the operation it runs and its input,
// exactly as an agent would send them over /api/v1:
// - claim runs requests.claim;
// - start and release run requests.set_status with in_progress and open;
// - post runs messages.post with the form's kind and text: a question may be
//   blocking, and an answer names the question it answers.
// The server action runs the operation through execute(), as the signed-in
// member's web session, once the form has passed the web UI's write checks
// (web-commands.ts), so the page has no rights the member lacks over
// /api/v1: an action the member's part in the request does not allow gets the
// same 403, and one the request's state does not allow the same 409, which
// the page shows with its status, title and detail. A form that names no
// action the page has, or leaves out a field its action needs, is refused as
// input that fails the schema, with 400, and runs nothing.

/** The actions the page's forms take, by the name their `action` field gives. */
export const REQUEST_PAGE_ACTIONS = ["claim", "start", "release", "post"] as const;
export type RequestPageAction = (typeof REQUEST_PAGE_ACTIONS)[number];

/** What one of the page's forms runs: its action, the operation and its input. */
export interface RequestPageWrite {
  action: RequestPageAction;
  commandId: string;
  input: Record<string, unknown>;
}

/** What the page shows once a form's action has run: that it ran, with the proposal it made, if any, or the refusal. */
export type RequestPageActionState =
  | null
  | { ok: true; action: RequestPageAction; proposal?: { id: string } }
  | { ok: false; action?: RequestPageAction; problem: ProblemDetails };

function invalid(name: string, message: string): Refusal {
  return new Refusal("invalid-input", message, { issues: [{ path: [name], message }] });
}

/** A field's value, as the form sent it; "" when it sent none. */
function field(fields: URLSearchParams, name: string): string {
  return fields.get(name) ?? "";
}

/** The operation a form of the page runs, and its input; a form the page does not have is refused with 400. */
export function requestPageWrite(fields: URLSearchParams): RequestPageWrite {
  const action = field(fields, "action");
  if (!(REQUEST_PAGE_ACTIONS as readonly string[]).includes(action)) throw invalid("action", "The form names no action this page takes.");
  const key = field(fields, "key");
  switch (action as RequestPageAction) {
    case "claim":
      return { action: "claim", commandId: claimRequest.id, input: { key } };
    case "start":
      return { action: "start", commandId: setRequestStatus.id, input: { key, state: "in_progress" } };
    case "release":
      return { action: "release", commandId: setRequestStatus.id, input: { key, state: "open" } };
    case "post": {
      const kind = field(fields, "kind");
      const body = field(fields, "body");
      if (kind === "question") return { action: "post", commandId: postMessage.id, input: { key, kind, body, blocking: fields.get("blocking") === "on" } };
      if (kind === "answer") return { action: "post", commandId: postMessage.id, input: { key, kind, body, questionId: field(fields, "questionId") } };
      return { action: "post", commandId: postMessage.id, input: { key, kind, body } };
    }
  }
}

/**
 * Runs the action one of the page's forms names, through `write`, which runs
 * the operation as the signed-in member's web session once the form passes
 * the web UI's write checks, given the form's CSRF token; answers what the
 * page then shows.
 */
export async function runRequestPageAction(
  fields: URLSearchParams,
  write: (commandId: string, input: unknown, csrfToken: string) => Promise<WebResult>,
): Promise<Exclude<RequestPageActionState, null>> {
  let planned: RequestPageWrite;
  try {
    planned = requestPageWrite(fields);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: httpProblem(error).body };
    throw error;
  }
  const result = await write(planned.commandId, planned.input, field(fields, "csrf"));
  if (!result.ok) return { ok: false, action: planned.action, problem: result.problem };
  return { ok: true, action: planned.action, ...(isProposalAnswer(result.output) ? { proposal: { id: result.output.proposal.id } } : {}) };
}
