import { describe, expect, it } from "vitest";
import {
  cancelledBy,
  confirmationOf,
  PROPOSAL_ENDINGS,
  proposalExpiresAt,
  rejectionOf,
  secondConfirmation,
  withdrawalOf,
  type CommitmentKind,
  type ProposalStanding,
  type ProposalState,
  type RequestActor,
  type RequestParties,
} from "../src/index.ts";

// How a proposal ends without taking effect (requests: How a proposal ends
// without taking effect; requests: The proposal's confirm page; design.md,
// Decisions this change rests on: D28 #16, D30 (4)). A pending proposal ends
// when its accountable human rejects it; when, once the accountable human has
// confirmed, a person who may give the other side's confirmation rejects it;
// when the user who proposed it withdraws it; when it expires, 7 days after it
// was created, which no confirmation restarts; or when it is cancelled: by its
// request reaching a terminal state, by a confirmed reassignment of the
// request, by its accountable human's removal, and, for a packet change, by
// the request's current revision moving past the revision it was based on. An
// ended proposal takes no confirmation, rejection or withdrawal (409), and it
// never comes back: undoing the decline or the reassignment that cancelled it
// leaves it cancelled. The other side rejecting before the accountable human
// has confirmed gets 409 too; anyone else who rejects, and anyone but the
// proposer who withdraws, gets 403.

const FE = "f0f0f0f0-0000-4000-8000-0000000000fe";
const BE = "b0b0b0b0-0000-4000-8000-0000000000be";
const OPS = "0f0f0f0f-0000-4000-8000-000000000005";
const ALICE = "a1a1a1a1-0000-4000-8000-000000000001";
const BOB = "b1b1b1b1-0000-4000-8000-000000000002";
const ERIN = "e1e1e1e1-0000-4000-8000-000000000003";
const CAROL = "c1c1c1c1-0000-4000-8000-000000000005";

const fe142: RequestParties = { targetTeamId: FE, requestingTeamId: BE, requestingUserId: ALICE, claimantId: BOB, claimantIsMember: true };
const alice: RequestActor = { userId: ALICE, teamIds: [BE] };
const bob: RequestActor = { userId: BOB, teamIds: [FE] };
const erin: RequestActor = { userId: ERIN, teamIds: [FE] };
const carol: RequestActor = { userId: CAROL, teamIds: [OPS] };

const CREATED = new Date("2026-10-01T09:00:00Z");
const DURING = new Date("2026-10-03T12:00:00Z");

function proposal(
  commitments: readonly CommitmentKind[],
  accountableUserId: string,
  options: { state?: ProposalState; accountableConfirmed?: boolean } = {},
): ProposalStanding {
  const side = accountableUserId === ALICE ? "requester_side" : "target_team";
  return {
    accountableUserId,
    second: secondConfirmation(commitments, side),
    accountableConfirmed: options.accountableConfirmed ?? false,
    state: options.state ?? "pending",
    createdAt: CREATED,
  };
}

type Outcome = "ok" | "forbidden" | "conflict";
const outcome = (verdict: { ok: true } | { ok: false; refusal: "forbidden" | "conflict" }): Outcome => (verdict.ok ? "ok" : verdict.refusal);

describe("the proposal's lifetime", () => {
  it("is 7 days from its creation", () => {
    expect(proposalExpiresAt(CREATED).toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });

  it.each([
    ["the day before it expires", "2026-10-07T08:00:00Z", "ok"],
    ["a moment before it expires", "2026-10-08T08:59:59.999Z", "ok"],
    ["the moment it expires", "2026-10-08T09:00:00Z", "conflict"],
    ["half an hour after it expired", "2026-10-08T09:30:00Z", "conflict"],
  ] as const)("takes a confirmation %s, or not", (_name, at, expected) => {
    expect(outcome(confirmationOf(proposal(["decline"], BOB), bob, fe142, new Date(at)))).toBe(expected);
  });

  it("is not restarted by the accountable human's confirmation", () => {
    // Alice confirmed on 2026-10-07; Bob's confirmation after 2026-10-08 09:00 is refused all the same.
    const halfConfirmed = proposal(["due_date"], ALICE, { accountableConfirmed: true });
    expect(outcome(confirmationOf(halfConfirmed, bob, fe142, new Date("2026-10-07T20:00:00Z")))).toBe("ok");
    expect(outcome(confirmationOf(halfConfirmed, bob, fe142, new Date("2026-10-08T09:30:00Z")))).toBe("conflict");
  });
});

describe("an ended proposal", () => {
  const cases = PROPOSAL_ENDINGS.flatMap((state) => [
    [state, "its accountable human's confirmation", proposal(["decline"], BOB, { state }), bob],
    [state, "the other side's confirmation", proposal(["due_date"], ALICE, { state, accountableConfirmed: true }), erin],
  ] as const);

  it.each(cases)("once %s, refuses %s with 409", (_state, _what, ended, actor) => {
    expect(outcome(confirmationOf(ended, actor, fe142, DURING))).toBe("conflict");
  });

  it.each(PROPOSAL_ENDINGS)("once %s, refuses a rejection and a withdrawal with 409", (state) => {
    const ended = proposal(["due_date"], ALICE, { state, accountableConfirmed: true });
    expect(outcome(rejectionOf(ended, alice, fe142, DURING))).toBe("conflict");
    expect(outcome(rejectionOf(ended, bob, fe142, DURING))).toBe("conflict");
    expect(outcome(withdrawalOf(ended, alice, DURING))).toBe("conflict");
  });

  it("refuses everything once it took effect", () => {
    const applied = proposal(["decline"], BOB, { state: "applied", accountableConfirmed: true });
    expect(outcome(confirmationOf(applied, bob, fe142, DURING))).toBe("conflict");
    expect(outcome(rejectionOf(applied, bob, fe142, DURING))).toBe("conflict");
    expect(outcome(withdrawalOf(applied, bob, DURING))).toBe("conflict");
  });
});

describe("who may reject a pending proposal", () => {
  it.each([
    ["its accountable human", proposal(["decline"], BOB), bob, "ok"],
    ["its accountable human after confirming it", proposal(["due_date"], ALICE, { accountableConfirmed: true }), alice, "ok"],
    ["the other side once the accountable human has confirmed", proposal(["due_date"], ALICE, { accountableConfirmed: true }), bob, "ok"],
    ["another person of the other side", proposal(["due_date"], ALICE, { accountableConfirmed: true }), erin, "ok"],
    ["the other side before the accountable human has confirmed", proposal(["due_date"], ALICE), bob, "conflict"],
    ["anyone else, for a decline", proposal(["decline"], BOB), carol, "forbidden"],
    ["a member of the target team, for another member's decline", proposal(["decline"], BOB), erin, "forbidden"],
    ["a member of a third team, for a confirmed due date", proposal(["due_date"], ALICE, { accountableConfirmed: true }), carol, "forbidden"],
  ] as const)("%s", (_name, pending, actor, expected) => {
    expect(outcome(rejectionOf(pending, actor, fe142, DURING))).toBe(expected);
  });
});

describe("who may withdraw a pending proposal", () => {
  it.each([
    ["the user who proposed it", proposal(["due_date"], ALICE), alice, "ok"],
    ["the user who proposed it, after confirming it", proposal(["due_date"], ALICE, { accountableConfirmed: true }), alice, "ok"],
    ["the other side", proposal(["due_date"], ALICE, { accountableConfirmed: true }), bob, "forbidden"],
    ["anyone else", proposal(["decline"], BOB), carol, "forbidden"],
  ] as const)("%s", (_name, pending, actor, expected) => {
    expect(outcome(withdrawalOf(pending, actor, DURING))).toBe(expected);
  });
});

describe("the proposals a change to the request cancels", () => {
  const proposals = [
    { id: "decline", kind: "decline", accountableUserId: BOB, baseRevision: null },
    { id: "due-date-on-3", kind: "due_date", accountableUserId: ALICE, baseRevision: 3 },
    { id: "scope-on-3", kind: "scope", accountableUserId: ALICE, baseRevision: 3 },
    { id: "scope-on-4", kind: "scope", accountableUserId: ALICE, baseRevision: 4 },
    { id: "reassign", kind: "reassign", accountableUserId: ERIN, baseRevision: null },
  ] as const;

  it.each([
    ["the request reaching a terminal state", { kind: "terminal_state" }, ["decline", "due-date-on-3", "scope-on-3", "scope-on-4", "reassign"], "terminal_state"],
    ["a confirmed reassignment, every other proposal", { kind: "reassigned", proposalId: "reassign" }, ["decline", "due-date-on-3", "scope-on-3", "scope-on-4"], "reassigned"],
    ["the removal of their accountable human", { kind: "member_removed", userId: ALICE }, ["due-date-on-3", "scope-on-3", "scope-on-4"], "accountable_removed"],
    ["revision 4, the packet changes based on revision 3", { kind: "revision_added", revision: 4 }, ["due-date-on-3", "scope-on-3"], "stale"],
    ["revision 5, every packet change", { kind: "revision_added", revision: 5 }, ["due-date-on-3", "scope-on-3", "scope-on-4"], "stale"],
    ["the undo of a commitment, nothing", { kind: "commitment_undone" }, [], undefined],
  ] as const)("cancels, for %s", (_name, change, cancelled, reason) => {
    const ended = cancelledBy(change, proposals);
    expect(ended.map(({ id }) => id)).toEqual(cancelled);
    expect(ended.every((cancellation) => cancellation.reason === reason)).toBe(true);
  });
});

describe("a proposal a decline or a reassignment cancelled", () => {
  it.each([
    ["a decline", { kind: "terminal_state" }],
    ["a reassignment", { kind: "reassigned", proposalId: "other" }],
  ] as const)("stays cancelled when %s is undone", (_name, change) => {
    const dueDate = { id: "due-date", kind: "due_date", accountableUserId: ALICE, baseRevision: 3 } as const;
    expect(cancelledBy(change, [dueDate]).map(({ id }) => id)).toEqual(["due-date"]);
    // The undo cancels nothing more and brings nothing back: the proposal is still cancelled, and takes no confirmation.
    expect(cancelledBy({ kind: "commitment_undone" }, [])).toEqual([]);
    const afterUndo = proposal(["due_date"], ALICE, { state: "cancelled", accountableConfirmed: true });
    expect(outcome(confirmationOf(afterUndo, bob, fe142, DURING))).toBe("conflict");
    expect(outcome(confirmationOf(afterUndo, alice, fe142, DURING))).toBe("conflict");
  });
});
