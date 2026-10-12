import { undoUntil, type CommitmentKind, type Review, type TextOrigin } from "@tiehall/core";
import { appliedCommitments, receipts, users } from "@tiehall/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  ACTION_RECEIPT,
  actionReceiptSentence,
  actionTitle,
  installLink,
  RECEIPT,
  RECEIPT_WITH_UNDO,
  receiptSentence,
  requestKey,
  serverTime,
  type ActionReceiptFacts,
  type ReceiptFacts,
  type ServerText,
} from "./email.ts";
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
//
// Every other action the confirmation step guards gives the person who
// confirmed it a receipt of the kind `confirmed` too, in the action's own
// transaction (decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (81); Technical decisions: T11): it names the action's
// command and keeps what the action's review page said, its title and its
// lines in Tiehall's words, each quote of text Tiehall did not write, such as
// a token's label or a client's name, left out (confirmation-step.ts). A
// review page shows no secret, no key and no token's value, so no receipt
// holds one. The receipt of a role change or of a member's removal goes to the
// person who confirmed it alone, as every receipt does.

export type ReceiptKind = "waits_for_other_side" | "took_effect" | "undone" | "confirmed";

/** A receipt as the standing list shows it: its sentence, until when it can be undone, and the proposal or the action it is about. */
export interface ReceiptView {
  id: string;
  kind: ReceiptKind;
  text: string;
  /** For the receipt that says a reversible commitment took effect, until when its undo page undoes it; otherwise null. */
  undoUntil: string | null;
  createdAt: string;
  /** The proposal a commitment's receipt is about; null for an action's receipt. */
  proposal: ProposalView | null;
  /** The action an action's receipt is about: its command and its title, as its review page named it; null for a commitment's receipt. */
  action: { id: string; title: string } | null;
}

/** What an undo record says about a commitment: when it took effect, and who undid it, if anyone. */
async function appliedOf({ tx, orgId }: OrgContext, proposalId: string) {
  const [row] = await tx
    .select({ appliedAt: appliedCommitments.appliedAt, undoneBy: users.githubLogin, undoneByBot: users.bot })
    .from(appliedCommitments)
    .leftJoin(users, and(eq(users.orgId, appliedCommitments.orgId), eq(users.id, appliedCommitments.undoneByUserId)))
    .where(and(eq(appliedCommitments.orgId, orgId), eq(appliedCommitments.proposalId, proposalId)));
  return row;
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

/** What a quote of text Tiehall did not write becomes in an action's receipt: a line in Tiehall's words that says where it was. */
const QUOTE_LEFT_OUT: Readonly<Record<TextOrigin, string>> = {
  "same team": "(The review page quoted text a member of your team wrote here; the receipt leaves it out.)",
  "other team": "(The review page quoted text another team wrote here; the receipt leaves it out.)",
  external: "(The review page quoted text from outside Tiehall here; the receipt leaves it out.)",
};

/** What an action's receipt keeps of its review page: the title and the lines in Tiehall's words, each quote left out. */
export function receiptReviewOf(review: Review): ActionReceiptFacts {
  return { title: review.title, lines: review.lines.map((line) => ("quote" in line ? QUOTE_LEFT_OUT[line.origin] : line.text)) };
}

/**
 * Gives the person who confirmed an action other than a proposal's its
 * receipt, in the action's transaction: the action's command and what its
 * review page said.
 */
export async function giveActionReceipt(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  receipt: { userId: string; action: string; review: Review; at: Date },
): Promise<void> {
  const kept = receiptReviewOf(receipt.review);
  // The sentence is made when the receipt is read; making it now refuses a review it could not be made from.
  actionReceiptSentence(kept);
  await tx.insert(receipts).values({ orgId, userId: receipt.userId, kind: "confirmed", action: receipt.action, review: kept, createdAt: receipt.at });
}

/** A receipt's facts from its proposal as it is now. */
function factsOf(kind: Exclude<ReceiptKind, "confirmed">, proposal: ProposalView, applied?: { undoneBy: string | null; undoneByBot: boolean | null }): ReceiptFacts {
  const undoneBy = applied?.undoneBy;
  return {
    kind,
    ...(undoneBy === undefined || undoneBy === null ? {} : { undoneBy, undoneByBot: applied?.undoneByBot === true }),
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
    const kind = row.kind as ReceiptKind;
    if (row.proposalId === null) {
      const kept = row.review as ActionReceiptFacts;
      views.push({
        id: row.id,
        kind,
        text: actionReceiptSentence(kept),
        undoUntil: null,
        createdAt: row.createdAt.toISOString(),
        proposal: null,
        action: { id: row.action ?? "", title: kept.title },
      });
      continue;
    }
    const proposal = await proposalView(context, row.proposalId);
    const applied = await appliedOf(context, row.proposalId);
    const commitment = kind as Exclude<ReceiptKind, "confirmed">;
    // The receipt that says a commitment took effect links its undo page while it can be undone.
    const until =
      kind === "took_effect" && applied !== undefined
        ? undoUntil({ kind: proposal.kind as CommitmentKind, appliedAt: applied.appliedAt, undone: applied.undoneBy !== null })
        : undefined;
    views.push({
      id: row.id,
      kind,
      text: receiptSentence(factsOf(commitment, proposal, applied)),
      undoUntil: until === undefined ? null : until.toISOString(),
      createdAt: row.createdAt.toISOString(),
      proposal,
      action: null,
    });
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
  async handle(_job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    let unsent: (
      | { id: string; email: string; proposalId: string; key: ServerText; sentence: ServerText; undoUntil: Date | undefined }
      | { id: string; email: string; title: ServerText; sentence: ServerText }
    )[];
    try {
      unsent = await withOrg(
        database,
        async (context) => {
          const rows = await context.tx
            .select({ id: receipts.id, kind: receipts.kind, proposalId: receipts.proposalId, review: receipts.review, email: users.email })
            .from(receipts)
            .innerJoin(users, and(eq(users.orgId, receipts.orgId), eq(users.id, receipts.userId)))
            .where(and(eq(receipts.orgId, context.orgId), isNull(receipts.emailedAt), isNotNull(users.email)))
            .orderBy(asc(receipts.createdAt), asc(receipts.id));
          const found: typeof unsent = [];
          for (const row of rows) {
            if (row.proposalId === null) {
              const kept = row.review as ActionReceiptFacts;
              found.push({ id: row.id, email: row.email ?? "", title: actionTitle(kept.title), sentence: actionReceiptSentence(kept) });
              continue;
            }
            const proposal = await proposalView(context, row.proposalId);
            const applied = await appliedOf(context, row.proposalId);
            const kind = row.kind as ReceiptKind;
            found.push({
              id: row.id,
              email: row.email ?? "",
              proposalId: row.proposalId,
              undoUntil:
                kind === "took_effect" && applied !== undefined
                  ? undoUntil({ kind: proposal.kind as CommitmentKind, appliedAt: applied.appliedAt, undone: applied.undoneBy !== null })
                  : undefined,
              key: requestKey(proposal.request.key),
              sentence: receiptSentence(factsOf(row.kind as Exclude<ReceiptKind, "confirmed">, proposal, applied)),
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
      if ("title" in receipt) {
        await mailer.send(receipt.email, ACTION_RECEIPT, { title: receipt.title, sentence: receipt.sentence });
      } else if (receipt.undoUntil !== undefined && receipt.undoUntil.getTime() > now().getTime()) {
        // The receipt that says a reversible commitment took effect links its undo page while it can be undone.
        await mailer.send(receipt.email, RECEIPT_WITH_UNDO, {
          key: receipt.key,
          sentence: receipt.sentence,
          until: serverTime(receipt.undoUntil),
          page: installLink(installUrl, `/confirm/${receipt.proposalId}/undo`),
        });
      } else {
        await mailer.send(receipt.email, RECEIPT, { key: receipt.key, sentence: receipt.sentence });
      }
      await withOrg(database, ({ tx, orgId }) =>
        tx.update(receipts).set({ emailedAt: now() }).where(and(eq(receipts.orgId, orgId), eq(receipts.id, receipt.id))),
      );
    }
  },
};
