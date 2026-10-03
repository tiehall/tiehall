import { describe, expect, it } from "vitest";
import { partsIn, REQUEST_ACTIONS, sideAllows, whoMay, type RequestAction, type RequestActor, type RequestParties } from "../src/index.ts";

// Which side may act on a request (requests: Which side may act on a request;
// requests: Allowed state changes; requests: Thread messages and blocking
// questions; design.md, Decisions this change rests on: D28 #3, #10; D29 (3);
// design.md, Readings to confirm with the founder: R14). Members of the target
// team claim, start, decline, mark done and reassign; the requester side, the
// requesting user and the members of the requesting team, withdraws, changes
// scope and adds packet revisions; either side proposes a due date and posts
// in the thread. Only the claimant releases a claim, except that any member of
// the target team may release one held by someone who is no longer a member of
// the install. A part comes from the person's place in the request, never from
// their role, so an admin in a third team is on neither side.

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
/** FE-143: open and unclaimed. */
const fe143: RequestParties = { ...fe142, claimantId: null };
/** FE-144: claimed by Dana, who has since been removed from the install. */
const fe144: RequestParties = { ...fe142, claimantId: DANA, claimantIsMember: false };

const alice: RequestActor = { userId: ALICE, teamIds: [BE] };
const bob: RequestActor = { userId: BOB, teamIds: [FE] };
const erin: RequestActor = { userId: ERIN, teamIds: [FE] };
const sam: RequestActor = { userId: SAM, teamIds: [BE] };
const carol: RequestActor = { userId: CAROL, teamIds: [OPS] };
/** Pat belongs to both teams. */
const pat: RequestActor = { userId: PAT, teamIds: [BE, FE] };
/** Alice after leaving team BE: still the requesting user. */
const aliceWithoutTeams: RequestActor = { userId: ALICE, teamIds: [] };

describe("a person's parts in a request", () => {
  it.each([
    ["Alice, who opened it", alice, fe142, ["requester_side"]],
    ["Sam, a member of the requesting team", sam, fe142, ["requester_side"]],
    ["Alice, who opened it and left the requesting team since", aliceWithoutTeams, fe142, ["requester_side"]],
    ["Bob, the claimant in the target team", bob, fe142, ["target_team", "claimant"]],
    ["Erin, another member of the target team", erin, fe142, ["target_team"]],
    ["Pat, a member of both teams", pat, fe142, ["target_team", "requester_side"]],
    ["Carol, a member of a third team", carol, fe142, []],
  ] as const)("%s", (_name, actor, request, parts) => {
    expect(partsIn(actor, request)).toEqual(parts);
  });

  it("puts a request with a team but no requesting user on the requesting team's side", () => {
    const opened = { ...fe142, requestingUserId: null };
    expect(partsIn(sam, opened)).toEqual(["requester_side"]);
    expect(partsIn(aliceWithoutTeams, opened)).toEqual([]);
  });
});

describe("the side rules", () => {
  const rows: [string, RequestActor, RequestParties, RequestAction, boolean][] = [
    // The target team claims, starts, declines, marks done and reassigns (D28 #3).
    ["a member of the target team claims", erin, fe143, "claim", true],
    ["a member of a third team cannot claim", carol, fe143, "claim", false],
    ["the requester cannot claim", alice, fe143, "claim", false],
    ["a member of the target team starts work", bob, fe142, "start", true],
    ["the requester cannot start work", alice, fe142, "start", false],
    ["a member of the target team declines", bob, fe142, "decline", true],
    ["the requester side cannot decline", alice, fe142, "decline", false],
    ["a member of the requesting team cannot decline either", sam, fe142, "decline", false],
    ["a member of the target team marks it done", erin, fe142, "mark_done", true],
    ["the requester cannot mark it done", alice, fe142, "mark_done", false],
    ["a member of the target team reassigns it", erin, fe142, "reassign", true],
    ["a member of a third team cannot reassign it", carol, fe142, "reassign", false],
    // The requester side withdraws, changes scope and adds revisions.
    ["the requester withdraws", alice, fe142, "withdraw", true],
    ["a member of the requesting team withdraws", sam, fe142, "withdraw", true],
    ["the requesting user withdraws after leaving the requesting team", aliceWithoutTeams, fe142, "withdraw", true],
    ["the target team cannot withdraw", bob, fe142, "withdraw", false],
    ["the requester changes the scope", alice, fe142, "change_scope", true],
    ["the target team cannot change the scope", erin, fe142, "change_scope", false],
    ["a member of the requesting team adds a packet revision", sam, fe142, "add_revision", true],
    ["the target team cannot add a packet revision", bob, fe142, "add_revision", false],
    // Either side proposes a due date and posts in the thread; a third team does neither.
    ["the target team proposes a due date", bob, fe142, "propose_due_date", true],
    ["the requester proposes a due date", alice, fe142, "propose_due_date", true],
    ["a member of a third team cannot propose a due date", carol, fe142, "propose_due_date", false],
    ["the target team posts in the thread", erin, fe142, "post_message", true],
    ["the requester side posts in the thread", sam, fe142, "post_message", true],
    ["a member of a third team cannot post in the thread", carol, fe142, "post_message", false],
    // A member of both teams holds both sides' rights.
    ["a member of both teams claims", pat, fe143, "claim", true],
    ["a member of both teams withdraws", pat, fe142, "withdraw", true],
    // Only the claimant releases a claim held by a member (requests: Allowed state changes).
    ["the claimant releases the claim", bob, fe142, "release", true],
    ["another member of the target team cannot release a member's claim", erin, fe142, "release", false],
    ["the requester cannot release the claim", alice, fe142, "release", false],
    // A claim held by someone no longer a member: any member of the target team may release it (D28 #10; D29 (3)).
    ["a member of the target team releases a departed member's claim", erin, fe144, "release", true],
    ["the requester side cannot release a departed member's claim", sam, fe144, "release", false],
    ["a member of a third team cannot release a departed member's claim", carol, fe144, "release", false],
    // With no claim at all, the target team passes the side rule and the state machine answers.
    ["a member of the target team asks to release an unclaimed request", erin, fe143, "release", true],
    ["the requester asks to release an unclaimed request", alice, fe143, "release", false],
  ];

  it.each(rows)("%s", (_name, actor, request, action, allowed) => {
    expect(sideAllows(actor, request, action)).toBe(allowed);
  });

  it("names, for every action, who may take it", () => {
    for (const action of REQUEST_ACTIONS) expect(whoMay(action), action).toMatch(/^Only .+\.$/);
    expect(whoMay("decline")).toBe("Only members of the request's target team may decline it.");
    expect(whoMay("withdraw")).toBe("Only the requester side, the user who opened the request or a member of its requesting team, may withdraw it.");
  });
});
