import { COMMITMENT_KINDS, PROPOSAL_STATES } from "@tiehall/core";
import { z } from "zod";
import { requestRef } from "./requests.ts";
import { user } from "./schemas.ts";

// Proposals as the operations return them (requests: Commitments become
// proposals; requests: What a proposal records and shows; public-api:
// Commitments over the API answer 202 with a proposal; design.md, Decisions
// this change rests on: D23). An operation flagged as a commitment answers a
// call that makes no commitment with its own output, and a call that makes one
// with the proposal it created instead, as `{ proposal }`: over REST with 202.
// So a commitment operation's own output never has a field named proposal,
// which the catalog checks. A proposal names its request, the kind of
// commitment, where it is, its accountable human, and when it was created and
// expires. It holds no confirm URL: agents read it.

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
