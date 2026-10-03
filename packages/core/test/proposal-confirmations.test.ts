import { describe, expect, it } from "vitest";
import {
  accountableSideOf,
  confirmationVerdict,
  mayGiveSecondConfirmation,
  secondConfirmation,
  type AccountableSide,
  type CommitmentKind,
  type PendingConfirmations,
  type RequestActor,
  type RequestParties,
} from "../src/index.ts";

// Which confirmations a commitment needs, who may give each and in what order
// (requests: Cross-team commitments need a confirmation from each side;
// requests: The proposal's confirm page; design.md, Decisions this change
// rests on: D23, D30 (2), (4)). Every proposal needs its accountable human's
// confirmation first. A due date also needs one from the other side of the
// accountable human's, as recorded when it was proposed: a member of the
// target team for the requester side, the requesting user or a member of the
// requesting team for the target team. A scope change while the request is
// claimed also needs the claimant's, or any target-team member's once the
// claimant is no longer a member of the install. Who belongs to the other
// side, and who holds the claim, are decided when the second confirmation is
// given, and it always comes from someone other than the accountable human.
// Every other commitment takes effect on the accountable human's
// confirmation alone. The other side confirming first gets 409, the
// accountable human confirming again 409, and anyone who may not give the
// confirmation 403.

const FE = "f0f0f0f0-0000-4000-8000-0000000000fe";
const BE = "b0b0b0b0-0000-4000-8000-0000000000be";
const OPS = "0f0f0f0f-0000-4000-8000-000000000005";

const ALICE = "a1a1a1a1-0000-4000-8000-000000000001";
const BOB = "b1b1b1b1-0000-4000-8000-000000000002";
const ERIN = "e1e1e1e1-0000-4000-8000-000000000003";
const SAM = "5a5a5a5a-0000-4000-8000-000000000004";
const CAROL = "c1c1c1c1-0000-4000-8000-000000000005";
const DANA = "da0a0a0a-0000-4000-8000-000000000006";
const PAT = "9a9a9a9a-0000-4000-8000-000000000007";

/** FE-142: Alice, of team BE, opened it to team FE, and Bob of FE holds its claim. */
const fe142: RequestParties = { targetTeamId: FE, requestingTeamId: BE, requestingUserId: ALICE, claimantId: BOB, claimantIsMember: true };
/** FE-142 once Bob released the claim, and nobody holds it. */
const unclaimed: RequestParties = { ...fe142, claimantId: null, claimantIsMember: false };
/** FE-142 once Erin claimed it after Bob released it. */
const claimedByErin: RequestParties = { ...fe142, claimantId: ERIN };
/** FE-142 claimed by Dana, who has since been removed from the install. */
const claimedByDana: RequestParties = { ...fe142, claimantId: DANA, claimantIsMember: false };

const alice: RequestActor = { userId: ALICE, teamIds: [BE] };
const bob: RequestActor = { userId: BOB, teamIds: [FE] };
const erin: RequestActor = { userId: ERIN, teamIds: [FE] };
const sam: RequestActor = { userId: SAM, teamIds: [BE] };
const carol: RequestActor = { userId: CAROL, teamIds: [OPS] };
/** Pat belongs to both teams. */
const pat: RequestActor = { userId: PAT, teamIds: [BE, FE] };
/** Sam after leaving team BE, still a member of the install. */
const samWithoutTeams: RequestActor = { userId: SAM, teamIds: [] };

/** A pending proposal, before or after its accountable human's confirmation. */
function pending(accountableUserId: string, commitments: readonly CommitmentKind[], side: AccountableSide, accountableConfirmed = false): PendingConfirmations {
  return { accountableUserId, second: secondConfirmation(commitments, side), accountableConfirmed };
}

describe("the side the accountable human is on", () => {
  it.each([
    ["Alice, who opened the request", alice, "requester_side"],
    ["Sam, of the requesting team", sam, "requester_side"],
    ["Bob, of the target team", bob, "target_team"],
    ["Pat, of both teams, who counts as the requester side", pat, "requester_side"],
    ["Carol, of a third team, who is on no side", carol, undefined],
  ] as const)("%s", (_name, actor, side) => {
    expect(accountableSideOf(actor, fe142)).toBe(side);
  });
});

describe("the second confirmation a commitment needs", () => {
  it.each([
    ["a due date proposed by the requester side", ["due_date"], "requester_side", ["target_team"]],
    ["a due date proposed by the target team", ["due_date"], "target_team", ["requester_side"]],
    ["a scope change while the request is claimed", ["scope"], "requester_side", ["claimant"]],
    ["a due date and a scope change in one packet change", ["due_date", "scope"], "requester_side", ["target_team", "claimant"]],
    ["a decline", ["decline"], "target_team", []],
    ["a reassignment", ["reassign"], "target_team", []],
    ["a done", ["done"], "target_team", []],
    ["a withdrawal", ["withdraw"], "requester_side", []],
  ] as const)("%s", (_name, commitments, side, second) => {
    expect(secondConfirmation(commitments, side)).toEqual(second);
  });
});

type Expected = { ok: true; step: "accountable" | "second"; takesEffect: boolean } | { ok: false; refusal: "forbidden" | "conflict" };

function expected(verdict: ReturnType<typeof confirmationVerdict>): Expected {
  return verdict.ok ? { ok: true, step: verdict.step, takesEffect: verdict.takesEffect } : { ok: false, refusal: verdict.refusal };
}

const FIRST = { ok: true, step: "accountable", takesEffect: false } as const;
const ONLY = { ok: true, step: "accountable", takesEffect: true } as const;
const SECOND = { ok: true, step: "second", takesEffect: true } as const;
const TOO_EARLY = { ok: false, refusal: "conflict" } as const;
const AGAIN = { ok: false, refusal: "conflict" } as const;
const NOT_THEIRS = { ok: false, refusal: "forbidden" } as const;

describe("who may confirm, and in what order", () => {
  it.each([
    // A decline Bob proposed takes effect on Bob's confirmation alone.
    ["Bob confirms the decline Bob proposed", pending(BOB, ["decline"], "target_team"), bob, fe142, ONLY],
    ["Erin, another member of FE, confirms Bob's decline", pending(BOB, ["decline"], "target_team"), erin, fe142, NOT_THEIRS],
    ["Alice confirms Bob's decline", pending(BOB, ["decline"], "target_team"), alice, fe142, NOT_THEIRS],
    ["Alice confirms the withdrawal Alice proposed", pending(ALICE, ["withdraw"], "requester_side"), alice, fe142, ONLY],

    // A due date Alice proposed waits for a member of the target team after Alice.
    ["Alice confirms the due date Alice proposed", pending(ALICE, ["due_date"], "requester_side"), alice, fe142, FIRST],
    ["Bob, of FE, confirms Alice's due date before Alice does", pending(ALICE, ["due_date"], "requester_side"), bob, fe142, TOO_EARLY],
    ["Carol, of a third team, confirms Alice's due date before Alice does", pending(ALICE, ["due_date"], "requester_side"), carol, fe142, NOT_THEIRS],
    ["Bob, of FE, confirms Alice's due date after Alice", pending(ALICE, ["due_date"], "requester_side", true), bob, fe142, SECOND],
    ["Erin, of FE, confirms Alice's due date after Alice", pending(ALICE, ["due_date"], "requester_side", true), erin, fe142, SECOND],
    ["Sam, of Alice's own team BE, confirms Alice's due date after Alice", pending(ALICE, ["due_date"], "requester_side", true), sam, fe142, NOT_THEIRS],
    ["Carol, of a third team, confirms Alice's due date after Alice", pending(ALICE, ["due_date"], "requester_side", true), carol, fe142, NOT_THEIRS],
    ["Alice confirms the due date Alice proposed again", pending(ALICE, ["due_date"], "requester_side", true), alice, fe142, AGAIN],

    // A due date Bob proposed for the target team waits for the requester side.
    ["Sam, of BE, confirms Bob's due date after Bob", pending(BOB, ["due_date"], "target_team", true), sam, fe142, SECOND],
    ["Alice, the requesting user, confirms Bob's due date after Bob", pending(BOB, ["due_date"], "target_team", true), alice, fe142, SECOND],
    ["Erin, of Bob's own team FE, confirms Bob's due date after Bob", pending(BOB, ["due_date"], "target_team", true), erin, fe142, NOT_THEIRS],
    ["Sam confirms Bob's due date before Bob does", pending(BOB, ["due_date"], "target_team"), sam, fe142, TOO_EARLY],

    // A member of both sides needs another person.
    ["Pat, of both teams, confirms their due date", pending(PAT, ["due_date"], "requester_side"), pat, fe142, FIRST],
    ["Pat confirms their due date again, as a member of FE", pending(PAT, ["due_date"], "requester_side", true), pat, fe142, AGAIN],
    ["Bob, another member of FE, confirms Pat's due date", pending(PAT, ["due_date"], "requester_side", true), bob, fe142, SECOND],

    // The side recorded when the proposal was created decides, even after the proposer left their team.
    ["Bob confirms the due date Sam proposed for BE, after Sam left BE", pending(SAM, ["due_date"], "requester_side", true), bob, fe142, SECOND],
    ["Sam confirms again after leaving BE", pending(SAM, ["due_date"], "requester_side", true), samWithoutTeams, fe142, AGAIN],

    // A scope change while the request is claimed waits for the claimant.
    ["Alice confirms the scope change Alice proposed", pending(ALICE, ["scope"], "requester_side"), alice, fe142, FIRST],
    ["Bob, the claimant, confirms Alice's scope change before Alice does", pending(ALICE, ["scope"], "requester_side"), bob, fe142, TOO_EARLY],
    ["Erin confirms Alice's scope change before Alice does", pending(ALICE, ["scope"], "requester_side"), erin, fe142, NOT_THEIRS],
    ["Bob, the claimant, confirms Alice's scope change after Alice", pending(ALICE, ["scope"], "requester_side", true), bob, fe142, SECOND],
    ["Erin, not the claimant, confirms Alice's scope change after Alice", pending(ALICE, ["scope"], "requester_side", true), erin, fe142, NOT_THEIRS],
    ["Erin confirms it once Erin holds the claim", pending(ALICE, ["scope"], "requester_side", true), erin, claimedByErin, SECOND],
    ["Bob confirms it after releasing the claim to Erin", pending(ALICE, ["scope"], "requester_side", true), bob, claimedByErin, NOT_THEIRS],
    ["Erin confirms it while nobody holds the claim", pending(ALICE, ["scope"], "requester_side", true), erin, unclaimed, NOT_THEIRS],
    ["Bob confirms it while nobody holds the claim", pending(ALICE, ["scope"], "requester_side", true), bob, unclaimed, NOT_THEIRS],
    ["Erin confirms it for Dana, a claimant who left the install", pending(ALICE, ["scope"], "requester_side", true), erin, claimedByDana, SECOND],
    ["Sam confirms it for Dana, a claimant who left the install", pending(ALICE, ["scope"], "requester_side", true), sam, claimedByDana, NOT_THEIRS],

    // A packet change that is both a due date and a scope change meets both rules.
    ["Bob, the claimant in FE, confirms Alice's due date and scope change", pending(ALICE, ["due_date", "scope"], "requester_side", true), bob, fe142, SECOND],
    ["Erin, in FE but not the claimant, confirms it", pending(ALICE, ["due_date", "scope"], "requester_side", true), erin, fe142, NOT_THEIRS],
  ] as const)("%s", (_name, proposal, actor, request, verdict) => {
    expect(expected(confirmationVerdict(proposal, actor, request))).toEqual(verdict);
  });

  it("gives every refusal a reason in Tiehall's own words", () => {
    for (const [proposal, actor] of [
      [pending(ALICE, ["due_date"], "requester_side"), bob],
      [pending(ALICE, ["due_date"], "requester_side", true), alice],
      [pending(BOB, ["decline"], "target_team"), erin],
    ] as const) {
      const verdict = confirmationVerdict(proposal, actor, fe142);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("who may give the other side's confirmation", () => {
  it("is nobody for a commitment that needs one confirmation", () => {
    for (const actor of [alice, bob, erin, sam, carol, pat]) {
      expect(mayGiveSecondConfirmation(pending(BOB, ["decline"], "target_team", true), actor, fe142)).toBe(false);
    }
  });

  it("is never the accountable human, even one on both sides", () => {
    expect(mayGiveSecondConfirmation(pending(PAT, ["due_date"], "requester_side", true), pat, fe142)).toBe(false);
    expect(mayGiveSecondConfirmation(pending(BOB, ["scope"], "requester_side", true), bob, fe142)).toBe(false);
  });

  it("follows the claim as it moves", () => {
    const scope = pending(ALICE, ["scope"], "requester_side", true);
    const who = (request: RequestParties) => [alice, bob, erin, sam, carol].filter((actor) => mayGiveSecondConfirmation(scope, actor, request)).map(({ userId }) => userId);
    expect(who(fe142)).toEqual([BOB]);
    expect(who(unclaimed)).toEqual([]);
    expect(who(claimedByErin)).toEqual([ERIN]);
    expect(who(claimedByDana)).toEqual([BOB, ERIN]);
  });
});
