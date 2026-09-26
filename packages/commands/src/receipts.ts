import { receipts, users } from "@tiehall/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { RECEIPT, receiptSentence, requestKey, type ReceiptFacts, type ServerText } from "./email.ts";
import { defineJobType } from "./jobs.ts";
import { proposalView, type ProposalView } from "./proposals.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";
import type { Writer } from "./write.ts";

// Receipts (requests: Receipts; requester-loop: The web inbox; design.md,
// Decisions this change rests on: D23, D28 #61, D30 (4); design.md,
// Self-hosting decisions: S7 and S10). Every confirmation gives the person who
// gave it a receipt, in the confirmation's own transaction: when it makes the
// commitment take effect, one that says so, to them and, for the other side's
// confirmation, to the accountable human too; otherwise one that says the
// commitment waits for the other side. A receipt's words are made when it is
// read, from Tiehall's records alone, so one that says a commitment waits shows
// how the proposal ended once it has. Receipts are listed in the standing list
// of the person's web inbox, and, with SMTP set, a worker job emails each once,
// whatever the person's digest setting, because receipts are transactional.

export type ReceiptKind = "waits_for_other_side" | "took_effect";

/** A receipt as the standing list shows it: its sentence, and the proposal it is about. */
export interface ReceiptView {
  id: string;
  kind: ReceiptKind;
  text: string;
  createdAt: string;
  proposal: ProposalView;
}

/** Gives the receipts of a confirmation, in its transaction. */
export async function giveReceipts(
  writer: Writer,
  confirmation: { proposalId: string; userId: string; accountableUserId: string; takesEffect: boolean },
): Promise<void> {
  const { proposalId, userId, accountableUserId, takesEffect } = confirmation;
  const kind: ReceiptKind = takesEffect ? "took_effect" : "waits_for_other_side";
  const to = takesEffect && userId !== accountableUserId ? [accountableUserId, userId] : [userId];
  for (const recipient of to) {
    await writer.tx.insert(receipts).values({ orgId: writer.orgId, userId: recipient, proposalId, kind, createdAt: writer.now() });
  }
}

/** A receipt's facts from its proposal as it is now. */
function factsOf(kind: ReceiptKind, proposal: ProposalView): ReceiptFacts {
  return {
    kind,
    commitment: proposal.kind,
    key: proposal.request.key,
    dueDate: proposal.change.dueDate,
    team: proposal.change.team?.key,
    state: proposal.state,
  };
}

/** The user's receipts, oldest first, as the standing list shows them. */
export async function receiptViews(context: OrgContext, userId: string): Promise<ReceiptView[]> {
  const rows = await context.tx
    .select()
    .from(receipts)
    .where(and(eq(receipts.orgId, context.orgId), eq(receipts.userId, userId)))
    .orderBy(asc(receipts.createdAt), asc(receipts.id));
  const views: ReceiptView[] = [];
  for (const row of rows) {
    const proposal = await proposalView(context, row.proposalId);
    const kind = row.kind as ReceiptKind;
    views.push({ id: row.id, kind, text: receiptSentence(factsOf(kind, proposal)), createdAt: row.createdAt.toISOString(), proposal });
  }
  return views;
}

/** Each minute, emails every receipt not emailed yet to its person's address, once email is set up. */
export const emailReceipts: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("receipts.email", 1, {
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, now, mailer }) {
    if (mailer === undefined || !mailer.configured) return;
    let unsent: { id: string; email: string; key: ServerText; sentence: ServerText }[];
    try {
      unsent = await withOrg(
        database,
        async (context) => {
          const rows = await context.tx
            .select({ id: receipts.id, kind: receipts.kind, proposalId: receipts.proposalId, email: users.email })
            .from(receipts)
            .innerJoin(users, and(eq(users.orgId, receipts.orgId), eq(users.id, receipts.userId)))
            .where(and(eq(receipts.orgId, context.orgId), isNull(receipts.emailedAt), isNotNull(users.email)))
            .orderBy(asc(receipts.createdAt), asc(receipts.id));
          const found = [];
          for (const row of rows) {
            const proposal = await proposalView(context, row.proposalId);
            found.push({
              id: row.id,
              email: row.email ?? "",
              key: requestKey(proposal.request.key),
              sentence: receiptSentence(factsOf(row.kind as ReceiptKind, proposal)),
            });
          }
          return found;
        },
        { readOnly: true },
      );
    } catch (error) {
      // Before setup there is no org, and so no receipt.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const receipt of unsent) {
      await mailer.send(receipt.email, RECEIPT, { key: receipt.key, sentence: receipt.sentence });
      await withOrg(database, ({ tx, orgId }) =>
        tx.update(receipts).set({ emailedAt: now() }).where(and(eq(receipts.orgId, orgId), eq(receipts.id, receipt.id))),
      );
    }
  },
};
