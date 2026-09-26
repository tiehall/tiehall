import { confirmProposal, type Packet } from "@tiehall/catalog";
import {
  changeRequest,
  confirmationOf,
  isTerminalState,
  proposalConfirmed,
  Refusal,
  requestReassigned,
  requestStateChanged,
  type CommitmentKind,
  type ProposalStanding,
  type ProposalState,
  type RequestLifecycle,
  type ReviewLine,
  type SecondConfirmer,
  type Surface,
} from "@tiehall/core";
import { proposalConfirmations, proposals, requestFormerKeys, requests } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { ConfirmationSubjects, ReviewContext, ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { recordHumanAction } from "./loop-limit.ts";
import { teamsOfMember } from "./members.ts";
import { packetRevisionOf, storePacketRevision } from "./packet-revisions.ts";
import { cancelProposals, noSuchProposal, proposalView } from "./proposals.ts";
import { actingUserOf, lifecycleOf, lockRequestById, partiesOf, saveLifecycle, teamActedFor } from "./request-changes.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import { requestView, type RequestRow } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// Confirming a proposal (requests: A confirmed commitment applies only if the
// request still allows it; requests: Cross-team commitments need a
// confirmation from each side; requests: The event log; agent-safety: Runaway
// agent loops flag the request needs_human; design.md, Decisions this change
// rests on: D30 (4); design.md, Self-hosting decisions: S7).
// proposals.confirm is an internal command: only the web UI runs it, for the
// signed-in user, with the confirmation step, whose nonce is bound to what the
// proposal proposes and the request it applies to, never to its
// confirmations, its request's claimant or its expiry. Inside withOrg(), with
// the proposal's row and its request's row locked, so confirmations and other
// changes to the request take turns:
// - the pure rules decide whether the person may give a confirmation now, and
//   which: 403 for someone who may not, 409 for the other side before the
//   accountable human, for the accountable human again, and for a proposal
//   that has taken effect, ended or expired;
// - the request's state must still allow the commitment, and a proposed packet
//   change must still be based on the current revision, or it gets 409;
// - the confirmation, its proposal.confirmed event and, when it is the last
//   one the proposal needs, the commitment with its own events commit
//   together, or none of them does;
// - a confirmation is a human action on the request: it clears the
//   needs_human flag and restarts the counts of agent writes.
// Applying a commitment marks the proposal applied first, then changes the
// request: a decline, a withdrawal or a done moves it to that state, which
// cancels every other pending proposal on it; a due date or a scope change
// adds the proposed packet as the next revision, recorded with the proposer's
// provenance, which cancels the packet changes based on an older revision; a
// reassignment makes the new team the target team, gives the request the next
// number of that team while its old key keeps naming it, returns it to open
// with no claimant, and cancels every other pending proposal on it (requests:
// Reassignment gives a new key and the old key redirects).

/** A proposal as stored, with its row locked until the call's transaction ends; 404 when there is none. */
export async function lockProposal({ tx, orgId }: OrgContext, proposalId: string) {
  const [row] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.orgId, orgId), eq(proposals.id, proposalId)))
    .for("update");
  if (row === undefined) throw noSuchProposal();
  return row;
}

export type StoredProposal = Awaited<ReturnType<typeof lockProposal>>;

/** The proposal as the pure rules see it. */
export async function standingOf({ tx, orgId }: OrgContext, stored: StoredProposal): Promise<ProposalStanding> {
  const received = await tx
    .select({ step: proposalConfirmations.step })
    .from(proposalConfirmations)
    .where(and(eq(proposalConfirmations.orgId, orgId), eq(proposalConfirmations.proposalId, stored.id)));
  return {
    accountableUserId: stored.accountableUserId,
    second: stored.secondConfirmation as SecondConfirmer[],
    accountableConfirmed: received.some(({ step }) => step === "accountable_human"),
    state: stored.state as ProposalState,
    createdAt: stored.createdAt,
  };
}

/** The state a decline, a withdrawal or a done moves a request to. */
const STATE_CHANGES = { decline: "decline", withdraw: "withdraw", done: "done" } as const;

/** Refuses, with 409, a confirmation the request no longer allows: its state, or a packet that moved past the proposal's base. */
async function assertStillAllowed(context: OrgContext, stored: StoredProposal, row: RequestRow): Promise<RequestLifecycle> {
  const current = await lifecycleOf(context, row);
  const kind = stored.kind as CommitmentKind;
  if (kind === "decline" || kind === "withdraw" || kind === "done") {
    const result = changeRequest(current, { kind: STATE_CHANGES[kind] });
    if (!result.ok) throw new Refusal("conflict", `The request no longer allows this commitment: ${result.conflict}`);
    return current;
  }
  if (isTerminalState(current.state)) {
    throw new Refusal("conflict", `The request is ${current.state}, which is final, so this commitment no longer applies.`);
  }
  if (stored.baseRevision !== null) {
    const { revision } = await packetRevisionOf(context, row.id);
    if (revision !== stored.baseRevision) {
      throw new Refusal("conflict", `The packet is at revision ${revision}, past the revision ${stored.baseRevision} this proposal was based on.`);
    }
  }
  return current;
}

/** Applies the commitment of the proposal, which its last confirmation made take effect. */
async function applyCommitment(writer: Writer, stored: StoredProposal, row: RequestRow, current: RequestLifecycle): Promise<void> {
  await writer.tx
    .update(proposals)
    .set({ state: "applied", endedAt: writer.now() })
    .where(and(eq(proposals.orgId, writer.orgId), eq(proposals.id, stored.id)));
  const kind = stored.kind as CommitmentKind;
  switch (kind) {
    case "decline":
    case "withdraw":
    case "done": {
      const result = changeRequest(current, { kind: STATE_CHANGES[kind] });
      if (!result.ok) throw new Refusal("conflict", result.conflict);
      await saveLifecycle(writer, row.id, result.next);
      await writer.record(requestStateChanged, { requestId: row.id, state: result.next.state, previousState: current.state });
      await cancelProposals(writer, row.id, { kind: "terminal_state" });
      return;
    }
    case "due_date":
    case "scope": {
      const { packet } = stored.change as { packet: Packet };
      await storePacketRevision(writer, row.id, packet, {
        actorKind: stored.actorKind as "agent" | "web_session" | "integration",
        actorUserId: stored.accountableUserId,
        client: stored.client,
        surface: stored.surface as Surface | null,
        teamId: stored.teamId,
      });
      return;
    }
    case "reassign": {
      const { teamId } = stored.change as { teamId: string };
      const number = await takeRequestNumber(writer, teamId);
      // The old key keeps naming the request; its number is never given to another request of its team.
      await writer.tx
        .insert(requestFormerKeys)
        .values({ orgId: writer.orgId, teamId: row.targetTeamId, number: row.number, requestId: row.id })
        .onConflictDoUpdate({ target: [requestFormerKeys.orgId, requestFormerKeys.teamId, requestFormerKeys.number], set: { requestId: row.id } });
      // It returns to open with no claimant; a blocking question still unanswered keeps it waiting, to return to open.
      const waiting = current.openBlockingQuestions > 0;
      const next: RequestLifecycle = waiting
        ? { state: "needs_info", claimantId: null, resumeState: "open", openBlockingQuestions: current.openBlockingQuestions }
        : { state: "open", claimantId: null, resumeState: null, openBlockingQuestions: 0 };
      await writer.tx
        .update(requests)
        .set({ targetTeamId: teamId, number, state: next.state, claimantUserId: null, resumeState: next.resumeState })
        .where(and(eq(requests.orgId, writer.orgId), eq(requests.id, row.id)));
      await writer.record(requestReassigned, { requestId: row.id, teamId, previousTeamId: row.targetTeamId });
      if (next.state !== current.state) {
        await writer.record(requestStateChanged, { requestId: row.id, state: next.state, previousState: current.state });
      }
      await cancelProposals(writer, row.id, { kind: "reassigned", proposalId: stored.id });
      return;
    }
  }
}

export const PROPOSAL_CONFIRMATION_HANDLERS: Handlers = {
  [confirmProposal.id]: defineHandler(confirmProposal, async ({ proposal: proposalId }, context) => {
    const userId = actingUserOf(context);
    const stored = await lockProposal(context, proposalId);
    const row = await lockRequestById(context, stored.requestId);
    const teamIds = (await teamsOfMember(context, userId)).map(({ id }) => id);
    const verdict = confirmationOf(await standingOf(context, stored), { userId, teamIds }, await partiesOf(context, row), context.now());
    if (!verdict.ok) throw new Refusal(verdict.refusal, verdict.reason);
    const current = await assertStillAllowed(context, stored, row);
    const teamId = await teamActedFor(context, userId, row);
    const step = verdict.step === "accountable" ? "accountable_human" : "other_side";
    return context.write(async (writer) => {
      await writer.tx.insert(proposalConfirmations).values({ orgId: writer.orgId, proposalId, step, userId, confirmedAt: writer.now() });
      await writer.record(proposalConfirmed, { requestId: row.id, proposalId, step, applied: verdict.takesEffect });
      if (verdict.takesEffect) await applyCommitment(writer, stored, row, current);
      await recordHumanAction(writer, row.id);
      return proposalView(writer, proposalId);
    }, { teamId });
  }),
};

/**
 * What a proposal's confirmation nonce is bound to: what the proposal
 * proposes and the request it applies to, which never change; not the
 * confirmations it has received, who holds the request's claim or when it
 * expires, so a confirmation sent after those change still matches.
 */
export const PROPOSAL_CONFIRMATION_SUBJECTS: ConfirmationSubjects = {
  [confirmProposal.id]: async (input, { tx, orgId }) => {
    const { proposal: proposalId } = input as { proposal: string };
    const [stored] = await tx
      .select({ requestId: proposals.requestId, kind: proposals.kind, change: proposals.change, baseRevision: proposals.baseRevision })
      .from(proposals)
      .where(and(eq(proposals.orgId, orgId), eq(proposals.id, proposalId)));
    return stored === undefined ? { proposal: proposalId } : { proposal: proposalId, ...stored };
  },
};

/** What each kind of commitment will do to the request, in Tiehall's words. */
function whatItDoes(kind: CommitmentKind, key: string, change: { packet?: Packet }, rules: readonly SecondConfirmer[], baseRevision: number | null): string {
  switch (kind) {
    case "decline":
      return `Decline ${key}: its state becomes declined, and every other pending proposal on it is cancelled.`;
    case "withdraw":
      return `Withdraw ${key}: its state becomes withdrawn, and every other pending proposal on it is cancelled.`;
    case "done":
      return `Mark ${key} done: its state becomes done, and every other pending proposal on it is cancelled.`;
    case "reassign":
      return `Reassign ${key} to another team: it returns to open with no claimant and gets a key of that team.`;
    case "due_date":
    case "scope": {
      // A due-date commitment is the one whose second confirmation comes from the other side of the accountable human's.
      const movesDueDate = rules.includes("target_team") || rules.includes("requester_side");
      const dueDate = change.packet?.due_date;
      const date = !movesDueDate ? "" : dueDate === undefined ? " It removes the due date." : ` Its due date becomes ${dueDate}.`;
      return `Add the packet below as the next revision of ${key}, after revision ${baseRevision ?? 1}.${date}`;
    }
  }
}

/** The review page of a proposal's confirmation, in Tiehall's own words, with what people wrote quoted as data. */
export const PROPOSAL_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [confirmProposal.id]: async (input, context: ReviewContext) => {
    const { proposal: proposalId } = input as { proposal: string };
    const view = await proposalView(context, proposalId);
    const [stored] = await context.tx
      .select({ teamId: proposals.teamId, change: proposals.change, baseRevision: proposals.baseRevision, second: proposals.secondConfirmation })
      .from(proposals)
      .where(and(eq(proposals.orgId, context.orgId), eq(proposals.id, proposalId)));
    const change = (stored?.change ?? {}) as { packet?: Packet };
    const rules = (stored?.second ?? []) as SecondConfirmer[];
    const viewerTeams = (await teamsOfMember(context, context.caller.userId)).map(({ id }) => id);
    const origin = stored?.teamId !== null && stored?.teamId !== undefined && viewerTeams.includes(stored.teamId) ? "same team" : "other team";
    const { key } = await requestView(context, view.request.id);
    const lines: ReviewLine[] = [{ text: whatItDoes(view.kind, key, change, rules, stored?.baseRevision ?? null) }];
    if (change.packet !== undefined) lines.push({ quote: JSON.stringify(change.packet.untrusted, null, 2), origin });
    const through = view.proposedBy.actorKind === "web_session" ? "in the web UI" : `through an agent on the ${view.proposedBy.surface ?? "api"} surface`;
    lines.push({ text: `${view.proposedBy.user.login} proposed it ${through}, as its accountable human.` });
    if (view.untrusted.client !== null) lines.push({ quote: view.untrusted.client, origin: "external" });
    for (const needed of view.confirmations.needed) {
      const received = view.confirmations.received.find(({ step }) => step === needed.step);
      const who = needed.step === "accountable_human" ? `${view.accountableHuman.login}, its accountable human` : otherSide(needed.rules, needed.team?.key, key);
      lines.push({ text: `It needs a confirmation from ${who}: ${received === undefined ? "not given yet" : `given by ${received.user.login} at ${received.confirmedAt}`}.` });
    }
    lines.push({ text: view.state === "pending" ? `It expires at ${view.expiresAt}.` : `It is ${view.state}, so it takes no confirmation.` });
    return { title: `Confirm a proposal for ${key}`, lines };
  },
};

/** Who may give the other side's confirmation, in Tiehall's words. */
function otherSide(rules: readonly string[], team: string | undefined, key: string): string {
  const members = team === undefined ? "a member of the team" : `a member of team ${team}`;
  const parts: string[] = [];
  if (rules.includes("target_team")) parts.push(members);
  if (rules.includes("requester_side")) parts.push(`the requesting user or ${members}`);
  if (rules.includes("claimant")) parts.push(`the claimant of ${key}`);
  const who = parts.length <= 1 ? (parts[0] ?? "the other side") : `a person who is ${parts.join(" and ")}`;
  return rules.includes("claimant") ? `${who}, or ${members} once the claimant is no longer a member of the install` : who;
}
