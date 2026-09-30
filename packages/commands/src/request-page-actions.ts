import { claimRequest, getPacket, isProposalAnswer, postMessage, proposeCommitment, proposeTool, setRequestStatus, type Packet } from "@tiehall/catalog";
import { httpProblem, Refusal, type ProblemDetails } from "@tiehall/core";
import { packetTextOf } from "./new-request.ts";
import type { WebResult } from "./web-commands.ts";

// The actions on the web UI's page of a request (public-api: One definition
// per operation, the same on every surface; requests: Claiming and starting
// work need no proposal; requests: Thread messages and blocking questions;
// requests: Commitments become proposals; handoff-packet: Packet changes that
// are commitments; design.md, Technical decisions: T3). Each of the page's
// forms posts to one server action, which names what the form does in its
// `action` field; this module turns the form's fields into the operation it
// runs and its input, exactly as an agent would send them over /api/v1:
// - claim runs requests.claim;
// - start and release run requests.set_status with in_progress and open;
// - post runs messages.post with the form's kind and text: a question may be
//   blocking, and an answer names the question it answers;
// - decline and done run requests.set_status with declined and done, and
//   reassign and withdraw run requests.propose, each a commitment that
//   becomes a proposal;
// - due_date and remove_due_date propose the due date the form names, or its
//   removal, and change_packet the packet's next revision, through the
//   propose tool's operation, naming the revision the page showed, so a page
//   that is no longer current is refused as /api/v1 refuses a stale If-Match.
//   The packet change takes the need, the acceptance criteria, the code refs
//   and the links from the form, as the web form that opens a request writes
//   them (new-request.ts), and keeps the rest of the packet as it is now: its
//   kind, its due date, its contract section and its extensions. While the
//   request is claimed, a change of its scope becomes a proposal; otherwise it
//   is the packet's next revision at once.
// The server action runs the operation through execute(), as the signed-in
// member's web session, once the form has passed the web UI's write checks
// (web-commands.ts), so the page has no rights the member lacks over
// /api/v1: an action the member's part in the request does not allow gets the
// same 403, and one the request's state does not allow the same 409, which
// the page shows with its status, title and detail; a commitment answers with
// the proposal it made, which the page links to its confirm page. A form that
// names no action the page has, or leaves out a field its action needs, is
// refused as input that fails the schema, with 400, and runs nothing.

/** The actions the page's forms take, by the name their `action` field gives. */
export const REQUEST_PAGE_ACTIONS = [
  "claim",
  "start",
  "release",
  "post",
  "decline",
  "done",
  "reassign",
  "withdraw",
  "due_date",
  "remove_due_date",
  "change_packet",
] as const;
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

/** Runs an operation as the signed-in member's web session: a read for the page's packet change, a write for the action. */
export interface RequestPageCalls {
  read(commandId: string, input: unknown): Promise<WebResult>;
  write(commandId: string, input: unknown, csrfToken: string): Promise<WebResult>;
}

/** A read the action needed was refused, with this problem. */
class ReadRefused extends Error {
  readonly problem: ProblemDetails;
  constructor(problem: ProblemDetails) {
    super(problem.title);
    this.problem = problem;
  }
}

function invalid(name: string, message: string): Refusal {
  return new Refusal("invalid-input", message, { issues: [{ path: [name], message }] });
}

/** A field's value, as the form sent it; "" when it sent none. */
function field(fields: URLSearchParams, name: string): string {
  return fields.get(name) ?? "";
}

/** The revision of the packet the page showed, which a packet change names as the one it expects; none when the form names no revision. */
function expectedRevisionOf(fields: URLSearchParams): { expectedRevision?: number } {
  const revision = field(fields, "revision");
  return /^[1-9][0-9]{0,8}$/.test(revision) ? { expectedRevision: Number(revision) } : {};
}

/** The packet a packet change proposes: the form's text fields in the current packet, everything else kept. */
function changedPacket(current: Packet, fields: URLSearchParams): Packet {
  const { need: _need, acceptance_criteria: _criteria, code_refs: _codeRefs, links: _links, ...kept } = current.untrusted;
  return { ...current, untrusted: { ...kept, ...packetTextOf(fields) } } as Packet;
}

/**
 * The operation a form of the page runs, and its input; `read` reads the
 * request's packet for a packet change. A form the page does not have is
 * refused with 400.
 */
export async function requestPageWrite(fields: URLSearchParams, read: RequestPageCalls["read"]): Promise<RequestPageWrite> {
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
    case "decline":
      return { action: "decline", commandId: setRequestStatus.id, input: { key, state: "declined" } };
    case "done":
      return { action: "done", commandId: setRequestStatus.id, input: { key, state: "done" } };
    case "reassign":
      return { action: "reassign", commandId: proposeCommitment.id, input: { kind: "reassign", key, team: field(fields, "team") } };
    case "withdraw":
      return { action: "withdraw", commandId: proposeCommitment.id, input: { kind: "withdraw", key } };
    case "due_date":
      return { action: "due_date", commandId: proposeTool.id, input: { kind: "due_date", key, dueDate: field(fields, "dueDate"), ...expectedRevisionOf(fields) } };
    case "remove_due_date":
      return { action: "remove_due_date", commandId: proposeTool.id, input: { kind: "due_date", key, dueDate: null, ...expectedRevisionOf(fields) } };
    case "change_packet": {
      const current = await read(getPacket.id, { key });
      if (!current.ok) throw new ReadRefused(current.problem);
      const packet = changedPacket((current.output as { packet: Packet }).packet, fields);
      return { action: "change_packet", commandId: proposeTool.id, input: { kind: "scope", key, packet, ...expectedRevisionOf(fields) } };
    }
  }
}

/**
 * Runs the action one of the page's forms names: `write` runs the operation
 * as the signed-in member's web session once the form passes the web UI's
 * write checks, given the form's CSRF token. Answers what the page then shows.
 */
export async function runRequestPageAction(fields: URLSearchParams, calls: RequestPageCalls): Promise<Exclude<RequestPageActionState, null>> {
  let planned: RequestPageWrite;
  try {
    planned = await requestPageWrite(fields, calls.read);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: httpProblem(error).body };
    if (error instanceof ReadRefused) return { ok: false, problem: error.problem };
    throw error;
  }
  const result = await calls.write(planned.commandId, planned.input, field(fields, "csrf"));
  if (!result.ok) return { ok: false, action: planned.action, problem: result.problem };
  return { ok: true, action: planned.action, ...(isProposalAnswer(result.output) ? { proposal: { id: result.output.proposal.id } } : {}) };
}
