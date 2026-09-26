// The request state machine (requests: Request states; requests: Allowed state
// changes; requests: Thread messages and blocking questions; requests:
// Claiming and starting work need no proposal; design.md, Decisions this
// change rests on: D28 #13, #17; design.md, Design rules: Requests and events).
// A pure module: given where a request is and a change, it returns where the
// request goes next, or a conflict, which the error model answers with 409.
// Who may ask for a change is the side rules' concern (request-sides.ts), and
// whether a change needs a proposal is the proposals' concern: this module
// only says whether the request's current state allows it.
//
// - A request is always in one of seven states; a new one starts open.
// - It counts as claimed while it has a claimant. A claim is taken only on an
//   open request. The claimant's release, or a target-team member's release
//   of a departed member's claim, returns it to open with no claimant.
// - A blocking question moves an open, claimed or in_progress request to
//   needs_info, and a request stays there until every blocking question has
//   an answer; then it returns to the state it had before the first of them.
//   A release while it waits keeps it waiting, and it then returns to open.
// - Decline and withdraw are allowed from every state that is not terminal,
//   and done from claimed, in_progress or needs_info.
// - Done, declined and withdrawn are terminal: every change from them is a
//   conflict. An answer to a question can still arrive and is kept, but it
//   changes no state. (Undoing a confirmed decline is the undo window's own
//   change, which the proposals build.)

export const REQUEST_STATES = ["open", "claimed", "in_progress", "needs_info", "done", "declined", "withdrawn"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TERMINAL_STATES = ["done", "declined", "withdrawn"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** The states a blocking question moves a request from, and so the states it returns to once its questions are answered. */
export const RESUMABLE_STATES = ["open", "claimed", "in_progress"] as const;
export type ResumableState = (typeof RESUMABLE_STATES)[number];

export function isTerminalState(state: RequestState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

function isResumableState(state: RequestState): state is ResumableState {
  return (RESUMABLE_STATES as readonly string[]).includes(state);
}

/** Where a request is: its state, who holds its claim, and what its blocking questions hold it in. */
export interface RequestLifecycle {
  state: RequestState;
  /** The user who holds the claim, by their Tiehall id; null while the request is unclaimed. */
  claimantId: string | null;
  /** While the request waits on blocking questions: the state it returns to once they are answered. */
  resumeState: ResumableState | null;
  /** The blocking questions on the request that have no answer yet. */
  openBlockingQuestions: number;
}

/** A change to a request's state. */
export type RequestChange =
  /** A member of the target team claims it for this user. */
  | { kind: "claim"; userId: string }
  /** Work on a claimed request starts. */
  | { kind: "start" }
  /** The claim is released. */
  | { kind: "release" }
  /** A blocking question is posted. */
  | { kind: "ask_blocking" }
  /** A blocking question that had no answer gets its first. */
  | { kind: "answer_blocking" }
  | { kind: "decline" }
  | { kind: "withdraw" }
  | { kind: "done" };

export type RequestChangeKind = RequestChange["kind"];

/** Where a change leads, or why the current state does not allow it, in Tiehall's own words. */
export type Transition = { ok: true; next: RequestLifecycle } | { ok: false; conflict: string };

/** Every way a lifecycle breaks the machine's own rules, as a sentence; none when it keeps them. */
export function lifecycleProblems(lifecycle: RequestLifecycle): string[] {
  const { state, claimantId, resumeState, openBlockingQuestions: questions } = lifecycle;
  const problems: string[] = [];
  if (!(REQUEST_STATES as readonly string[]).includes(state)) problems.push(`${String(state)} is not a request state.`);
  if (!Number.isSafeInteger(questions) || questions < 0) problems.push("The count of blocking questions is a whole number, 0 or more.");
  switch (state) {
    case "open":
      if (claimantId !== null) problems.push("An open request has no claimant.");
      if (resumeState !== null || questions !== 0) problems.push("An open request waits on no blocking question.");
      break;
    case "claimed":
    case "in_progress":
      if (claimantId === null) problems.push(`A request that is ${state} has a claimant.`);
      if (resumeState !== null || questions !== 0) problems.push(`A request that is ${state} waits on no blocking question.`);
      break;
    case "needs_info":
      if (questions < 1) problems.push("A request in needs_info waits on at least one blocking question.");
      if (resumeState === null) problems.push("A request in needs_info has a state to return to.");
      else if ((resumeState === "open") !== (claimantId === null)) {
        problems.push("A request in needs_info has a claimant exactly when it returns to claimed or in_progress.");
      }
      break;
    default:
      // A terminal request keeps what it had when it ended, for the undo of a decline.
      break;
  }
  return problems;
}

function conflict(text: string): Transition {
  return { ok: false, conflict: text };
}

function moved(next: RequestLifecycle): Transition {
  return { ok: true, next };
}

const OPEN: RequestLifecycle = { state: "open", claimantId: null, resumeState: null, openBlockingQuestions: 0 };

/**
 * Where a change takes a request, or the conflict that refuses it. It throws a
 * TypeError for a lifecycle that breaks the machine's own rules, which is a
 * bug in the caller, never a refusal.
 */
export function changeRequest(current: RequestLifecycle, change: RequestChange): Transition {
  const problems = lifecycleProblems(current);
  if (problems.length > 0) throw new TypeError(problems.join(" "));
  const { state } = current;

  if (isTerminalState(state)) {
    if (change.kind === "answer_blocking" && current.openBlockingQuestions > 0) {
      return moved({ ...current, openBlockingQuestions: current.openBlockingQuestions - 1 });
    }
    return conflict(`The request is ${state}, which is final, so its state no longer changes.`);
  }

  switch (change.kind) {
    case "claim":
      if (state === "open") return moved({ state: "claimed", claimantId: change.userId, resumeState: null, openBlockingQuestions: 0 });
      if (current.claimantId !== null) return conflict("The request is already claimed; only an open request can be claimed.");
      return conflict("The request waits for answers to its blocking questions; only an open request can be claimed.");

    case "start":
      if (state === "claimed") return moved({ ...current, state: "in_progress" });
      if (state === "in_progress") return conflict("Work on the request has already started.");
      if (state === "open") return conflict("The request is open; it is claimed before work on it starts.");
      return conflict("The request waits for answers to its blocking questions; work starts on a claimed request.");

    case "release":
      if (current.claimantId === null) return conflict("Nobody holds a claim on the request, so there is no claim to release.");
      if (state === "needs_info") return moved({ ...current, claimantId: null, resumeState: "open" });
      return moved(OPEN);

    case "ask_blocking":
      if (state === "needs_info") return moved({ ...current, openBlockingQuestions: current.openBlockingQuestions + 1 });
      if (!isResumableState(state)) throw new TypeError(`A blocking question cannot move a request that is ${state}.`);
      return moved({ ...current, state: "needs_info", resumeState: state, openBlockingQuestions: 1 });

    case "answer_blocking": {
      if (state !== "needs_info") return conflict("No blocking question on the request waits for an answer.");
      const left = current.openBlockingQuestions - 1;
      if (left > 0) return moved({ ...current, openBlockingQuestions: left });
      const resume = current.resumeState ?? "open";
      return moved({ ...current, state: resume, resumeState: null, openBlockingQuestions: 0 });
    }

    case "decline":
      return moved({ ...current, state: "declined" });

    case "withdraw":
      return moved({ ...current, state: "withdrawn" });

    case "done":
      if (state === "open") return conflict("The request is open; only a claimed request, or one in progress or waiting on a question, can be marked done.");
      return moved({ ...current, state: "done" });
  }
}
