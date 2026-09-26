import { rejectProposal, withdrawProposal } from "@tiehall/catalog";
import { proposalEnded, Refusal, rejectionOf, withdrawalOf, type ProposalEnding } from "@tiehall/core";
import { proposals } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { lockProposal, standingOf } from "./proposal-confirmations.ts";
import { proposalView, type ProposalView } from "./proposals.ts";
import { actingUserOf, lockRequestById, partiesOf, teamActedFor } from "./request-changes.ts";
import type { Writer } from "./write.ts";

// How a proposal ends without taking effect, by a person's choice (requests:
// How a proposal ends without taking effect; requests: The proposal's confirm
// page; requests: The event log; design.md, Decisions this change rests on:
// D28 #16, D30 (4); design.md, Readings to confirm with the founder: R12).
// proposals.reject and proposals.withdraw are internal commands the web UI
// runs inside withOrg(), with the proposal's row and its request's row
// locked. A rejection comes from the accountable human, or, once that human
// has confirmed, from a person who may give the other side's confirmation
// (409 before then); a withdrawal from the user who proposed it; anyone else
// gets 403, and a proposal that has ended already gets 409. Neither needs the
// confirmation step, because each only ends the proposal without any effect,
// and neither is a human action that clears the needs_human flag. Each ends
// the proposal with its proposal.ended event, which names how it ended, and
// the request stays as it was.

/** Ends a pending proposal without taking effect, with the event that names how. */
export async function endProposal(writer: Writer, requestId: string, proposalId: string, how: Exclude<ProposalEnding, "cancelled">): Promise<void> {
  await writer.tx
    .update(proposals)
    .set({ state: how, endedAt: writer.now() })
    .where(and(eq(proposals.orgId, writer.orgId), eq(proposals.id, proposalId)));
  await writer.record(proposalEnded, { requestId, proposalId, how });
}

/** Rejects or withdraws the proposal for the user the call acts for, once the rules allow it. */
async function end(context: HandlerContext, proposalId: string, how: "rejected" | "withdrawn"): Promise<ProposalView> {
  const userId = actingUserOf(context);
  const stored = await lockProposal(context, proposalId);
  const row = await lockRequestById(context, stored.requestId);
  const actor = { userId, teamIds: (await teamsOfMember(context, userId)).map(({ id }) => id) };
  const standing = await standingOf(context, stored);
  const verdict =
    how === "rejected" ? rejectionOf(standing, actor, await partiesOf(context, row), context.now()) : withdrawalOf(standing, actor, context.now());
  if (!verdict.ok) throw new Refusal(verdict.refusal, verdict.reason);
  const teamId = await teamActedFor(context, userId, row);
  return context.write(async (writer) => {
    await endProposal(writer, row.id, proposalId, how);
    return proposalView(writer, proposalId);
  }, { teamId });
}

export const PROPOSAL_ENDING_HANDLERS: Handlers = {
  [rejectProposal.id]: defineHandler(rejectProposal, async ({ proposal }, context) => end(context, proposal, "rejected")),
  [withdrawProposal.id]: defineHandler(withdrawProposal, async ({ proposal }, context) => end(context, proposal, "withdrawn")),
};
