import { allows, type Access, type Part } from "./roles.ts";

// Which side may act on a request (requests: Which side may act on a request;
// requests: Allowed state changes; requests: Thread messages and blocking
// questions; requests: A removed member's claims stay and their proposals are
// cancelled; design.md, Decisions this change rests on: D28 #3, #10; D29 (3);
// design.md, Readings to confirm with the founder: R14). A pure module. The
// right to act on a request comes from the person's part in it, whether they
// act in the web UI or through an agent, and never from their role, so an
// admin is on no side of a request they have no part in:
// - members of the target team claim the request, start work on it, decline
//   it, mark it done and reassign it;
// - the requester side, the requesting user and the members of the requesting
//   team, withdraws it, changes its scope and adds packet revisions;
// - either side proposes a due date and posts comments, questions and answers;
// - only the claimant releases a claim, except that any member of the target
//   team may release a claim held by someone who is no longer a member of the
//   install.
// A person whose side does not hold the right is refused with 403, before the
// state machine is asked, so nothing changes. Holding the right to a commitment
// lets the person start its proposal; the proposals decide when it applies.

export const REQUEST_ACTIONS = [
  "claim",
  "start",
  "release",
  "decline",
  "mark_done",
  "reassign",
  "withdraw",
  "change_scope",
  "add_revision",
  "propose_due_date",
  "post_message",
] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/** Who the request's parties are, by their Tiehall ids. */
export interface RequestParties {
  targetTeamId: string;
  /** The requesting team, which every request has. */
  requestingTeamId: string;
  /** The requesting user; none when a team is the requester, as for a contract-change request whose PR author is not a member. */
  requestingUserId: string | null;
  /** The user who holds the claim; null while the request is unclaimed. */
  claimantId: string | null;
  /** Whether the claimant is still a member of the install. */
  claimantIsMember: boolean;
}

/** The person who asks to act, and the teams they belong to now. */
export interface RequestActor {
  userId: string;
  teamIds: readonly string[];
}

/** The parts a person holds in a request: its target team, its requester side and its claim, in that order. */
export function partsIn(actor: RequestActor, request: RequestParties): Part[] {
  const parts: Part[] = [];
  if (actor.teamIds.includes(request.targetTeamId)) parts.push("target_team");
  if (request.requestingUserId === actor.userId || actor.teamIds.includes(request.requestingTeamId)) parts.push("requester_side");
  if (request.claimantId !== null && request.claimantId === actor.userId) parts.push("claimant");
  return parts;
}

const TARGET_TEAM: Access = { kind: "part", parts: ["target_team"] };
const REQUESTER_SIDE: Access = { kind: "part", parts: ["requester_side"] };
const EITHER_SIDE: Access = { kind: "part", parts: ["target_team", "requester_side"] };

/** Who may take each action but a release, which depends on who holds the claim. */
const SIDE_RULES: Readonly<Record<Exclude<RequestAction, "release">, Access>> = {
  claim: TARGET_TEAM,
  start: TARGET_TEAM,
  decline: TARGET_TEAM,
  mark_done: TARGET_TEAM,
  reassign: TARGET_TEAM,
  withdraw: REQUESTER_SIDE,
  change_scope: REQUESTER_SIDE,
  add_revision: REQUESTER_SIDE,
  propose_due_date: EITHER_SIDE,
  post_message: EITHER_SIDE,
};

/**
 * Whether a person's side allows the action on the request. A release is the
 * claimant's; a claim held by someone who is no longer a member is also any
 * target-team member's, and so is a request nobody holds, where the state
 * machine then answers that there is no claim to release.
 */
export function sideAllows(actor: RequestActor, request: RequestParties, action: RequestAction): boolean {
  const parts = partsIn(actor, request);
  if (action === "release") {
    if (parts.includes("claimant")) return true;
    const releasable = request.claimantId === null || !request.claimantIsMember;
    return releasable && parts.includes("target_team");
  }
  // The role plays no part here: allows() decides a part rule by the parts alone.
  return allows({ role: "member", parts }, SIDE_RULES[action]);
}

const VERBS: Readonly<Record<RequestAction, string>> = {
  claim: "claim it",
  start: "start work on it",
  release: "release its claim",
  decline: "decline it",
  mark_done: "mark it done",
  reassign: "reassign it to another team",
  withdraw: "withdraw it",
  change_scope: "change its scope",
  add_revision: "add a revision of its packet",
  propose_due_date: "propose a due date for it",
  post_message: "post in its thread",
};

/** Who may take the action, in Tiehall's own words, for the 403 that refuses anyone else. */
export function whoMay(action: RequestAction): string {
  const verb = VERBS[action];
  if (action === "release") {
    return `Only the claimant may ${verb}, or a member of its target team once the claimant is no longer a member of the install.`;
  }
  const rule = SIDE_RULES[action];
  if (rule === TARGET_TEAM) return `Only members of the request's target team may ${verb}.`;
  if (rule === REQUESTER_SIDE) return `Only the requester side, the user who opened the request or a member of its requesting team, may ${verb}.`;
  return `Only the request's two sides, its requester side and the members of its target team, may ${verb}.`;
}
