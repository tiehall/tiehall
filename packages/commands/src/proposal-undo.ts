import { undoCommitment, type Packet } from "@tiehall/catalog";
import {
  proposalUndone,
  Refusal,
  requestReassigned,
  requestStateChanged,
  undoOf,
  type CommitmentKind,
  type RequestLifecycle,
} from "@tiehall/core";
import { appliedCommitments, proposalConfirmations, receipts, requestFormerKeys, requests } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { packetRevisionOf, storePacketRevision } from "./packet-revisions.ts";
import { lockProposal, type BeforeCommitment } from "./proposal-confirmations.ts";
import { proposalView } from "./proposals.ts";
import { actingUserOf, lifecycleOf, lockRequestById, saveLifecycle, teamActedFor } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// Undoing a commitment (requests: The undo window for reversible commitments;
// requests: Request states; requests: Reassignment gives a new key and the old
// key redirects; requests: Receipts; agent-safety: Actions that need the
// confirmation step; design.md, Decisions this change rests on: D28 #18, #34,
// D30 (4); design.md, Self-hosting decisions: S7). proposals.undo is an
// internal command that only the web UI runs, with the confirmation step, from
// the undo page the receipt of a commitment that took effect links,
// /confirm/{proposal}/undo. Inside withOrg(), with the proposal's row, its
// record of what the commitment replaced and its request's row locked:
// - the pure rules decide: only a due date, a scope change, a reassignment
//   and a decline have an undo, for 15 minutes from when it took effect, once,
//   by a person who confirmed it (409 or 403 otherwise);
// - the request must still be as the commitment left it: a due date or a scope
//   change is not undone once a newer revision came (409), so no later
//   revision is lost;
// - the undo restores what the request had before: the earlier packet, as the
//   next revision; the state and claim before a decline; the old team, number
//   and state before a reassignment, whose new key then names the old one;
// - the undo and its proposal.undone event, recorded as a web session, commit
//   together with the change, and each person who confirmed the commitment
//   gets a receipt for it. The proposals the commitment cancelled stay
//   cancelled. An undo is not a human action: it leaves a needs_human flag.

/** The record of what a commitment replaced, locked until the call's transaction ends; undefined for one with no undo. */
async function lockApplied({ tx, orgId }: OrgContext, proposalId: string) {
  const [row] = await tx
    .select()
    .from(appliedCommitments)
    .where(and(eq(appliedCommitments.orgId, orgId), eq(appliedCommitments.proposalId, proposalId)))
    .for("update");
  return row;
}

async function confirmersOf({ tx, orgId }: OrgContext, proposalId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: proposalConfirmations.userId })
    .from(proposalConfirmations)
    .where(and(eq(proposalConfirmations.orgId, orgId), eq(proposalConfirmations.proposalId, proposalId)));
  return rows.map(({ userId }) => userId);
}

/** Refuses, with 409, an undo of a commitment whose request moved on since it took effect. */
async function assertAsLeft(context: OrgContext, kind: CommitmentKind, row: RequestRow, createdRevision: number | null, change: { teamId?: string }): Promise<void> {
  if (kind === "due_date" || kind === "scope") {
    const { revision } = await packetRevisionOf(context, row.id);
    if (revision !== createdRevision) {
      throw new Refusal("conflict", `The packet is at revision ${revision}, past the revision ${createdRevision ?? 0} this commitment added, so undoing it would lose that revision.`);
    }
  }
  if (kind === "decline" && row.state !== "declined") throw new Refusal("conflict", "The request is no longer declined.");
  if (kind === "reassign" && row.targetTeamId !== change.teamId) throw new Refusal("conflict", "The request is no longer with the team this reassignment moved it to.");
}

/** Restores what the request had before the commitment. */
async function restore(writer: Writer, kind: CommitmentKind, row: RequestRow, before: BeforeCommitment, current: RequestLifecycle): Promise<void> {
  // A blocking question answered since keeps the request out of needs_info.
  const waiting = before.state === "needs_info" && current.openBlockingQuestions === 0;
  const lifecycle: RequestLifecycle = waiting
    ? { state: before.resumeState ?? "open", claimantId: before.claimantId, resumeState: null, openBlockingQuestions: 0 }
    : { state: before.state, claimantId: before.claimantId, resumeState: before.resumeState, openBlockingQuestions: current.openBlockingQuestions };
  switch (kind) {
    case "decline":
      await saveLifecycle(writer, row.id, lifecycle);
      await writer.record(requestStateChanged, { requestId: row.id, state: lifecycle.state, previousState: current.state });
      return;
    case "due_date":
    case "scope": {
      const earlier = await packetRevisionOf(writer, row.id, before.revision);
      await storePacketRevision(writer, row.id, earlier.packet as Packet);
      return;
    }
    case "reassign": {
      if (before.teamId === undefined || before.number === undefined) throw new Error("A reassignment's record names the team and number it replaced.");
      // The new key names the request still, and its old key is its own again.
      await writer.tx
        .insert(requestFormerKeys)
        .values({ orgId: writer.orgId, teamId: row.targetTeamId, number: row.number, requestId: row.id })
        .onConflictDoUpdate({ target: [requestFormerKeys.orgId, requestFormerKeys.teamId, requestFormerKeys.number], set: { requestId: row.id } });
      await writer.tx
        .delete(requestFormerKeys)
        .where(and(eq(requestFormerKeys.orgId, writer.orgId), eq(requestFormerKeys.teamId, before.teamId), eq(requestFormerKeys.number, before.number)));
      await writer.tx
        .update(requests)
        .set({ targetTeamId: before.teamId, number: before.number, state: lifecycle.state, claimantUserId: lifecycle.claimantId, resumeState: lifecycle.resumeState })
        .where(and(eq(requests.orgId, writer.orgId), eq(requests.id, row.id)));
      await writer.record(requestReassigned, { requestId: row.id, teamId: before.teamId, previousTeamId: row.targetTeamId });
      if (lifecycle.state !== current.state) {
        await writer.record(requestStateChanged, { requestId: row.id, state: lifecycle.state, previousState: current.state });
      }
      return;
    }
    default:
      throw new Error("Only a due date, a scope change, a reassignment and a decline can be undone.");
  }
}

export const PROPOSAL_UNDO_HANDLERS: Handlers = {
  [undoCommitment.id]: defineHandler(undoCommitment, async ({ proposal: proposalId }, context) => {
    const userId = actingUserOf(context);
    const stored = await lockProposal(context, proposalId);
    if (stored.state !== "applied") throw new Refusal("conflict", "This proposal did not take effect, so there is nothing to undo.");
    const applied = await lockApplied(context, proposalId);
    const kind = stored.kind as CommitmentKind;
    const confirmedBy = await confirmersOf(context, proposalId);
    const verdict = undoOf(
      { kind, appliedAt: applied?.appliedAt ?? stored.endedAt ?? new Date(0), undone: applied?.undoneAt !== null && applied?.undoneAt !== undefined, confirmedBy },
      userId,
      context.now(),
    );
    if (!verdict.ok) throw new Refusal(verdict.refusal, verdict.reason);
    if (applied === undefined) throw new Error("A reversible commitment that took effect has its record of what it replaced.");
    const row = await lockRequestById(context, stored.requestId);
    await assertAsLeft(context, kind, row, applied.createdRevision, stored.change as { teamId?: string });
    const current = await lifecycleOf(context, row);
    const teamId = await teamActedFor(context, userId, row);
    return context.write(async (writer) => {
      await writer.tx
        .update(appliedCommitments)
        .set({ undoneAt: writer.now(), undoneByUserId: userId })
        .where(and(eq(appliedCommitments.orgId, writer.orgId), eq(appliedCommitments.proposalId, proposalId)));
      await writer.record(proposalUndone, { requestId: row.id, proposalId });
      await restore(writer, kind, row, applied.before as BeforeCommitment, current);
      for (const confirmer of [...new Set(confirmedBy)]) {
        await writer.tx.insert(receipts).values({ orgId: writer.orgId, userId: confirmer, proposalId, kind: "undone", createdAt: writer.now() });
      }
      return proposalView(writer, proposalId);
    }, { teamId });
  }),
};

/** What undoing each kind of commitment restores, in Tiehall's words. */
const UNDOES: Readonly<Record<string, (key: string) => string>> = {
  decline: (key) => `Undo the decline of ${key}: it returns to the state it had before, with the claim it had.`,
  due_date: (key) => `Undo the due date change of ${key}: its packet gets the due date it had before, as its next revision.`,
  scope: (key) => `Undo the scope change of ${key}: its packet gets the scope it had before, as its next revision.`,
  reassign: (key) => `Undo the reassignment of ${key}: it returns to its old team, with its old key, state and claim.`,
};

/** The review page of an undo, in Tiehall's own words. */
export const UNDO_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [undoCommitment.id]: async (input, context) => {
    const { proposal: proposalId } = input as { proposal: string };
    const view = await proposalView(context, proposalId);
    const what = UNDOES[view.kind];
    const lines = [
      { text: what === undefined ? `A ${view.kind} commitment has no undo.` : what(view.request.key) },
      { text: "The proposals this commitment cancelled stay cancelled." },
      { text: "Each person who confirmed it gets a receipt that says you undid it." },
    ];
    return { title: `Undo the ${view.kind === "due_date" ? "due date change" : view.kind === "scope" ? "scope change" : view.kind === "reassign" ? "reassignment" : view.kind} of ${view.request.key}`, lines };
  },
};
