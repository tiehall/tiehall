import { rejectProposal, withdrawProposal } from "@tiehall/catalog";
import { proposalEnded, Refusal, rejectionOf, withdrawalOf, type ProposalEnding } from "@tiehall/core";
import { proposals } from "@tiehall/db";
import { and, asc, eq, lte } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { teamsOfMember } from "./members.ts";
import { lockProposalWithRequest, standingOf } from "./proposal-confirmations.ts";
import { proposalView, type ProposalView } from "./proposals.ts";
import { actingUserOf, partiesOf, teamActedFor } from "./request-changes.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";
import { writeIn, type Writer } from "./write.ts";

// How a proposal ends without taking effect, by a person's choice (requests:
// How a proposal ends without taking effect; requests: The proposal's confirm
// page; requests: The event log; design.md, Decisions this change rests on:
// D28 #16, D30 (4); design.md, Readings to confirm with the founder: R12).
// proposals.reject and proposals.withdraw are internal commands the web UI
// runs inside withOrg(), with its request's row and then the proposal's row
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
  const { stored, row } = await lockProposalWithRequest(context, proposalId);
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

// Expiry (requests: How a proposal ends without taking effect; design.md,
// Decisions this change rests on: D28 #16, D30 (4); design.md, Technical
// decisions: T6). Every confirmation a proposal needs comes within 7 days of
// its creation, and nothing restarts that time. Each minute a worker job ends
// every pending proposal whose time is over by the worker's clock as expired,
// each with its proposal.ended event, recorded as a system action; no email
// goes out for it. Until the job has run, a confirmation of such a proposal is
// refused all the same, by the call's own clock.

export const expireProposals: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("proposals.expire", 1, {
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, now }) {
    try {
      await withOrg(database, async (context) => {
        const due = await context.tx
          .select({ id: proposals.id, requestId: proposals.requestId })
          .from(proposals)
          .where(and(eq(proposals.orgId, context.orgId), eq(proposals.state, "pending"), lte(proposals.expiresAt, now())))
          .orderBy(asc(proposals.expiresAt), asc(proposals.id))
          .for("update", { skipLocked: true });
        if (due.length === 0) return;
        const jobs = {
          send: async () => {
            throw new Error("Expiring a proposal starts no job.");
          },
        };
        await writeIn(
          context,
          jobs,
          { actorKind: "system" },
          async (writer) => {
            for (const { id, requestId } of due) await endProposal(writer, requestId, id, "expired");
          },
          { now },
        );
      });
    } catch (error) {
      // Before setup there is no org, and so no proposal.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
