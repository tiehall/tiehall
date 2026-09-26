import { describe, expect, it } from "vitest";
import {
  changeRequest,
  isTerminalState,
  REQUEST_STATES,
  TERMINAL_STATES,
  type RequestChange,
  type RequestLifecycle,
  type RequestState,
} from "../src/index.ts";

// The request state machine (requests: Request states; requests: Allowed state
// changes; requests: Thread messages and blocking questions; design.md,
// Decisions this change rests on: D28 #13, #17; design.md, Design rules:
// Requests and events). A request is in one of seven states. It is claimed
// while it has a claimant. A blocking question moves an open, claimed or
// in_progress request to needs_info, where it stays until every blocking
// question has an answer, and then returns to the state it had before. Done,
// declined and withdrawn are terminal: a change from one of them is a conflict,
// which the error model answers with 409.

const BOB = "0b0b0b0b-0000-4000-8000-000000000001";
const ERIN = "0e0e0e0e-0000-4000-8000-000000000002";

const open: RequestLifecycle = { state: "open", claimantId: null, resumeState: null, openBlockingQuestions: 0 };
const claimed: RequestLifecycle = { state: "claimed", claimantId: BOB, resumeState: null, openBlockingQuestions: 0 };
const inProgress: RequestLifecycle = { state: "in_progress", claimantId: BOB, resumeState: null, openBlockingQuestions: 0 };
/** Blocked on one question asked while it was claimed by Bob. */
const blockedWhileClaimed: RequestLifecycle = { state: "needs_info", claimantId: BOB, resumeState: "claimed", openBlockingQuestions: 1 };
/** Blocked on two questions asked while Bob was working on it. */
const blockedTwiceInProgress: RequestLifecycle = { state: "needs_info", claimantId: BOB, resumeState: "in_progress", openBlockingQuestions: 2 };
/** Blocked on one question asked during triage, before anyone claimed it. */
const blockedDuringTriage: RequestLifecycle = { state: "needs_info", claimantId: null, resumeState: "open", openBlockingQuestions: 1 };

const claim = (userId: string): RequestChange => ({ kind: "claim", userId });
const start: RequestChange = { kind: "start" };
const release: RequestChange = { kind: "release" };
const askBlocking: RequestChange = { kind: "ask_blocking" };
const answerBlocking: RequestChange = { kind: "answer_blocking" };
const decline: RequestChange = { kind: "decline" };
const withdraw: RequestChange = { kind: "withdraw" };
const done: RequestChange = { kind: "done" };

/** A terminal request, reached from the given lifecycle. */
function ended(state: RequestState, from: RequestLifecycle = claimed): RequestLifecycle {
  return { ...from, state };
}

describe("the request states", () => {
  it("are exactly the seven states, and a new request starts open", () => {
    expect(REQUEST_STATES).toEqual(["open", "claimed", "in_progress", "needs_info", "done", "declined", "withdrawn"]);
    expect(open.state).toBe(REQUEST_STATES[0]);
  });

  it("have done, declined and withdrawn as the terminal ones", () => {
    expect(TERMINAL_STATES).toEqual(["done", "declined", "withdrawn"]);
    expect(REQUEST_STATES.filter(isTerminalState)).toEqual(["done", "declined", "withdrawn"]);
  });
});

describe("an allowed change", () => {
  const rows: [string, RequestLifecycle, RequestChange, RequestLifecycle][] = [
    // Claiming and starting work (requests: Claiming and starting work need no proposal).
    ["an open request is claimed", open, claim(BOB), claimed],
    ["a claimed request moves to in_progress", claimed, start, inProgress],
    // The claimant's release, back to open with no claimant (requests: Allowed state changes).
    ["a claimed request is released", claimed, release, open],
    ["a request in progress is released", inProgress, release, open],
    // A released request can be claimed again, by anyone the side rules allow.
    ["a released request is claimed by someone else", open, claim(ERIN), { ...claimed, claimantId: ERIN }],
    // One blocking question (requests: Thread messages and blocking questions).
    ["a blocking question during triage", open, askBlocking, blockedDuringTriage],
    ["a blocking question while claimed", claimed, askBlocking, blockedWhileClaimed],
    [
      "a blocking question during work",
      inProgress,
      askBlocking,
      { state: "needs_info", claimantId: BOB, resumeState: "in_progress", openBlockingQuestions: 1 },
    ],
    ["the answer to the triage question", blockedDuringTriage, answerBlocking, open],
    ["the answer to the question asked while claimed", blockedWhileClaimed, answerBlocking, claimed],
    // Two blocking questions need two answers.
    [
      "a second blocking question",
      { ...blockedTwiceInProgress, openBlockingQuestions: 1 },
      askBlocking,
      blockedTwiceInProgress,
    ],
    [
      "the first of two answers",
      blockedTwiceInProgress,
      answerBlocking,
      { ...blockedTwiceInProgress, openBlockingQuestions: 1 },
    ],
    ["the second of two answers", { ...blockedTwiceInProgress, openBlockingQuestions: 1 }, answerBlocking, inProgress],
    // A release while blocked keeps the request blocked; it returns to open once the questions are answered.
    [
      "a release while blocked",
      blockedWhileClaimed,
      release,
      { state: "needs_info", claimantId: null, resumeState: "open", openBlockingQuestions: 1 },
    ],
    // Decline and withdraw from any state that is not terminal (D28 #13).
    ["a decline during triage", open, decline, ended("declined", open)],
    ["a decline while claimed", claimed, decline, ended("declined", claimed)],
    ["a decline in progress", inProgress, decline, ended("declined", inProgress)],
    ["a decline while blocked", blockedWhileClaimed, decline, ended("declined", blockedWhileClaimed)],
    ["a withdrawal during triage", open, withdraw, ended("withdrawn", open)],
    ["a withdrawal while claimed", claimed, withdraw, ended("withdrawn", claimed)],
    ["a withdrawal in progress", inProgress, withdraw, ended("withdrawn", inProgress)],
    ["a withdrawal while blocked on a question", blockedTwiceInProgress, withdraw, ended("withdrawn", blockedTwiceInProgress)],
    // Done from claimed, in_progress or needs_info (D28 #13).
    ["done while claimed", claimed, done, ended("done", claimed)],
    ["done in progress", inProgress, done, ended("done", inProgress)],
    ["done while blocked on a question", blockedTwiceInProgress, done, ended("done", blockedTwiceInProgress)],
    // An answer that arrives after the request ended is kept, and changes no state.
    [
      "an answer after a withdrawal",
      ended("withdrawn", blockedWhileClaimed),
      answerBlocking,
      { ...ended("withdrawn", blockedWhileClaimed), openBlockingQuestions: 0 },
    ],
  ];

  it.each(rows)("%s", (_name, from, change, next) => {
    expect(changeRequest(from, change)).toEqual({ ok: true, next });
  });
});

describe("a change the current state does not allow", () => {
  const rows: [string, RequestLifecycle, RequestChange][] = [
    ["claiming a claimed request again", claimed, claim(ERIN)],
    ["claiming a request in progress", inProgress, claim(ERIN)],
    ["claiming a request blocked while claimed", blockedWhileClaimed, claim(ERIN)],
    ["claiming a request blocked during triage", blockedDuringTriage, claim(BOB)],
    ["starting an open request", open, start],
    ["starting a request already in progress", inProgress, start],
    ["starting a blocked request", blockedWhileClaimed, start],
    ["releasing an open request, which nobody holds", open, release],
    ["releasing a request blocked during triage, which nobody holds", blockedDuringTriage, release],
    ["marking an open request done", open, done],
    ["answering when no blocking question waits", claimed, answerBlocking],
    ["answering an open request", open, answerBlocking],
  ];

  it.each(rows)("%s is a conflict", (_name, from, change) => {
    const result = changeRequest(from, change);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/\S/);
  });
});

describe("a terminal state", () => {
  const changes: [string, RequestChange][] = [
    ["claim", claim(ERIN)],
    ["start", start],
    ["release", release],
    ["ask_blocking", askBlocking],
    ["decline", decline],
    ["withdraw", withdraw],
    ["done", done],
  ];
  const rows = TERMINAL_STATES.flatMap((state) => changes.map(([name, change]) => [state, name, change] as const));

  it.each(rows)("%s refuses %s with a conflict that names the state", (state, _name, change) => {
    const result = changeRequest(ended(state), change);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toContain(state);
  });
});

describe("a lifecycle that breaks the machine's own rules", () => {
  const broken: [string, RequestLifecycle][] = [
    ["an open request with a claimant", { ...open, claimantId: BOB }],
    ["a claimed request without a claimant", { ...claimed, claimantId: null }],
    ["a blocked request with no blocking question", { ...blockedWhileClaimed, openBlockingQuestions: 0 }],
    ["a blocked request with no state to return to", { ...blockedWhileClaimed, resumeState: null }],
    ["a request blocked during triage that has a claimant", { ...blockedDuringTriage, claimantId: BOB }],
    ["a request blocked while claimed that has no claimant", { ...blockedWhileClaimed, claimantId: null }],
    ["a request in progress with a blocking question", { ...inProgress, openBlockingQuestions: 1 }],
    ["a negative count of questions", { ...ended("done"), openBlockingQuestions: -1 }],
  ];

  it.each(broken)("is refused as a bug: %s", (_name, lifecycle) => {
    expect(() => changeRequest(lifecycle, decline)).toThrow(TypeError);
  });
});
