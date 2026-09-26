import { partsIn, type RequestActor, type RequestParties } from "./request-sides.ts";

// Commitments and the confirmations their proposals need (requests:
// Commitments become proposals; requests: Cross-team commitments need a
// confirmation from each side; requests: The proposal's confirm page;
// design.md, Decisions this change rests on: D23, D30 (2), (4)). A pure
// module.
//
// A commitment an agent or a person starts becomes a proposal, which takes
// effect once the people it needs have confirmed it in the web UI:
// - first its accountable human, the user who started it;
// - then, for a due date, a person on the other side of the request from the
//   side the accountable human was on when it was proposed: a member of the
//   target team for the requester side, and the requesting user or a member of
//   the requesting team for the target team. A person on both sides counts as
//   the requester side;
// - and, for a scope change while the request is claimed, the claimant, or any
//   member of the target team once the claimant is no longer a member of the
//   install.
// A packet change that is both needs one second confirmation that meets both
// rules. Who belongs to the other side, and who holds the claim, are decided
// when the second confirmation is given; the accountable human never gives it,
// so one person's confirmation never counts for both sides. Every other
// commitment takes effect on the accountable human's confirmation alone.
//
// A confirmation from someone who may not give it is refused with 403; one
// from the other side before the accountable human's, and the accountable
// human's own a second time, with 409, and the proposal keeps waiting.

/** The kinds of commitment a proposal can make (design.md, Decisions this change rests on: D23). */
export const COMMITMENT_KINDS = ["due_date", "scope", "decline", "reassign", "withdraw", "done"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/** The rules a second confirmation, from the other side of the request, can follow. */
export const SECOND_CONFIRMERS = ["target_team", "requester_side", "claimant"] as const;
export type SecondConfirmer = (typeof SECOND_CONFIRMERS)[number];

/** The side of the request the accountable human was on when they proposed it. */
export const ACCOUNTABLE_SIDES = ["requester_side", "target_team"] as const;
export type AccountableSide = (typeof ACCOUNTABLE_SIDES)[number];

/** The side a person is on: the requester side when they are on it, even if also in the target team; undefined for neither. */
export function accountableSideOf(actor: RequestActor, request: RequestParties): AccountableSide | undefined {
  const parts = partsIn(actor, request);
  if (parts.includes("requester_side")) return "requester_side";
  if (parts.includes("target_team")) return "target_team";
  return undefined;
}

/**
 * The rules the second confirmation of a proposal making these commitments
 * must all meet; none when the accountable human's confirmation is enough. A
 * scope commitment is one made while the request was claimed.
 */
export function secondConfirmation(commitments: readonly CommitmentKind[], side: AccountableSide): SecondConfirmer[] {
  const rules: SecondConfirmer[] = [];
  if (commitments.includes("due_date")) rules.push(side === "requester_side" ? "target_team" : "requester_side");
  if (commitments.includes("scope")) rules.push("claimant");
  return rules;
}

/** Where a pending proposal stands in its confirmations. */
export interface PendingConfirmations {
  accountableUserId: string;
  /** The rules its second confirmation must meet; none when one confirmation is enough. */
  second: readonly SecondConfirmer[];
  /** Whether its accountable human has confirmed it. */
  accountableConfirmed: boolean;
}

/** Whether a person meets a rule of the second confirmation on the request as it is now. */
function meets(rule: SecondConfirmer, actor: RequestActor, request: RequestParties): boolean {
  const parts = partsIn(actor, request);
  switch (rule) {
    case "target_team":
      return parts.includes("target_team");
    case "requester_side":
      return parts.includes("requester_side");
    case "claimant":
      if (request.claimantId === null) return false;
      return request.claimantIsMember ? request.claimantId === actor.userId : parts.includes("target_team");
  }
}

/**
 * Whether a person may give the proposal's second confirmation on the request
 * as it is now, whether or not the accountable human has confirmed yet: never
 * the accountable human, and only someone who meets every rule it needs.
 */
export function mayGiveSecondConfirmation(proposal: PendingConfirmations, actor: RequestActor, request: RequestParties): boolean {
  if (proposal.second.length === 0 || actor.userId === proposal.accountableUserId) return false;
  return proposal.second.every((rule) => meets(rule, actor, request));
}

/** Why a proposal refuses an action, as the error model answers it: 403 forbidden or 409 conflict. */
export type ProposalRefusal = { ok: false; refusal: "forbidden" | "conflict"; reason: string };

/** A confirmation a proposal takes: whose it is, and whether it makes the commitment take effect. */
export type ConfirmationVerdict = { ok: true; step: "accountable" | "second"; takesEffect: boolean } | ProposalRefusal;

function refuse(refusal: "forbidden" | "conflict", reason: string): ProposalRefusal {
  return { ok: false, refusal, reason };
}

/** Whether a pending proposal takes this person's confirmation on the request as it is now, and what it does. */
export function confirmationVerdict(proposal: PendingConfirmations, actor: RequestActor, request: RequestParties): ConfirmationVerdict {
  if (actor.userId === proposal.accountableUserId) {
    if (proposal.accountableConfirmed) {
      return refuse("conflict", "You have confirmed this proposal already; it now waits for a confirmation from the other side of the request.");
    }
    return { ok: true, step: "accountable", takesEffect: proposal.second.length === 0 };
  }
  if (!mayGiveSecondConfirmation(proposal, actor, request)) {
    return refuse("forbidden", "You may not confirm this proposal: it waits for its accountable human or for a person it names on the other side of the request.");
  }
  if (!proposal.accountableConfirmed) {
    return refuse("conflict", "The proposal waits for its accountable human to confirm it first; the other side confirms after that.");
  }
  return { ok: true, step: "second", takesEffect: true };
}
