import { COMMITMENT_KINDS, PROPOSAL_STATES, SECOND_CONFIRMERS } from "@tiehall/core";
import { z } from "zod";
import { requestRef, teamRef } from "./requests.ts";
import { user } from "./schemas.ts";

// Proposals as the operations return them (requests: Commitments become
// proposals; requests: What a proposal records and shows; public-api:
// Commitments over the API answer 202 with a proposal; design.md, Decisions
// this change rests on: D23). An operation flagged as a commitment answers a
// call that makes no commitment with its own output, and a call that makes one
// with the proposal it created instead, as `{ proposal }`: over REST with 202.
// So a commitment operation's own output never has a field named proposal,
// which the catalog checks. A proposal names its request, the kind of
// commitment, where it is, its accountable human, the confirmations it needs
// and those it has received, and when it was created and expires. It holds no
// confirm URL: agents read it.

/** The two steps of a proposal's confirmations: its accountable human's, then, where it needs one, the other side's. */
export const CONFIRMATION_STEPS = ["accountable_human", "other_side"] as const;

/** A confirmation a proposal needs. */
const neededConfirmation = z.object({
  step: z.enum(CONFIRMATION_STEPS),
  /** For the accountable human's step, that human; null for the other side's, whose person is decided when they confirm. */
  user: user.nullable(),
  /**
   * For the other side's step, the rules its person meets, all of them: a
   * member of the target team, the requesting user or a member of the
   * requesting team, or the claimant (a member of the target team once the
   * claimant is no longer a member of the install); none for the accountable
   * human's.
   */
  rules: z.array(z.enum(SECOND_CONFIRMERS)),
  /** For the other side's step, the team whose members may give it: the target team, or the requesting team. */
  team: teamRef.nullable(),
});

/** A confirmation a proposal has received: its step, who gave it and when. */
const receivedConfirmation = z.object({
  step: z.enum(CONFIRMATION_STEPS),
  user,
  confirmedAt: z.iso.datetime(),
});

/** A proposal as the operations return it. */
export const proposal = z.object({
  id: z.uuid(),
  request: requestRef,
  kind: z.enum(COMMITMENT_KINDS).meta({ description: "The kind of commitment it proposes." }),
  state: z.enum(PROPOSAL_STATES).meta({
    description: "pending while it waits for its confirmations; applied once it took effect; otherwise how it ended without taking effect.",
  }),
  /** The user who proposed it, whose confirmation it needs first. */
  accountableHuman: user,
  /** The confirmations it needs, in order, and those it has received. */
  confirmations: z.object({ needed: z.array(neededConfirmation), received: z.array(receivedConfirmation) }),
  createdAt: z.iso.datetime(),
  /** 7 days after it was created: every confirmation it needs comes before then, or it expires. */
  expiresAt: z.iso.datetime(),
});

/** What a commitment operation answers a call that makes a commitment with: the proposal it created. */
export const proposalAnswer = z.object({ proposal });

/** Whether an operation's answer is the proposal a commitment created, rather than the operation's own output. */
export function isProposalAnswer(output: unknown): output is z.input<typeof proposalAnswer> {
  return typeof output === "object" && output !== null && !Array.isArray(output) && Object.hasOwn(output, "proposal");
}
