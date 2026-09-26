import { getProposal, type Packet, type proposal } from "@tiehall/catalog";
import {
  Refusal,
  accountableSideOf,
  cancelledBy,
  proposalCreated,
  proposalEnded,
  proposalExpiresAt,
  secondConfirmation,
  type CommitmentKind,
  type CancelReason,
  type ProposalCancellingChange,
  type ProposalState,
  type SecondConfirmer,
} from "@tiehall/core";
import { proposalConfirmations, proposals, requests, teams, users } from "@tiehall/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf, partiesOf, stampOf, teamActedFor } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";
import { requestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// Proposals (requests: Commitments become proposals; handoff-packet: Packet
// changes that are commitments; requests: Cross-team commitments need a
// confirmation from each side; design.md, Decisions this change rests on:
// D23; design.md, Technical decisions: T3). A commitment started for a user,
// by an agent on any surface or by a person in the web UI, is not applied:
// execute() lets the handler of an operation flagged as a commitment, once it
// has found that the call makes one and that the caller's side and the
// request's state allow it, create a proposal instead. The proposal records:
// - its request and the kind of commitment;
// - its accountable human, the user the call acts for, and the side of the
//   request they are on now, which decides who gives a due date's second
//   confirmation, with the rules its second confirmation must meet (none for
//   a commitment that needs one confirmation);
// - who proposed it, as execute() stamped it from the caller: the actor kind,
//   the client, the surface, and the team the user acted for;
// - what it changes, and, for a packet change, the revision it was based on;
// - when it was created, by the call's clock, and when it expires, 7 days
//   later.
// Creating it is a write on the request, which the loop limit counts for an
// agent, and it commits with its domain event, proposal.created, or not at
// all. The request itself does not change.

/** A commitment as its operation's handler found it in the call. */
export interface Commitment {
  kind: CommitmentKind;
  /** The commitments it makes, for its second confirmation; just its kind unless one packet change makes two. */
  commitments?: readonly CommitmentKind[];
  /** What it changes: for a packet change, { packet }; for a reassignment, { teamId }; otherwise {}. */
  change: Record<string, unknown>;
  /** For a packet change, the revision it is based on. */
  baseRevision?: number;
}

/** A proposal as the operations return it. */
export type ProposalView = z.input<typeof proposal>;

/** The proposal a call made instead of its commitment, as a commitment operation answers with it. */
export interface ProposalAnswer {
  proposal: ProposalView;
}

/** Creates the proposal for a commitment the call makes on the request, whose row the call has locked. */
export async function createProposal(context: HandlerContext, row: RequestRow, commitment: Commitment): Promise<ProposalAnswer> {
  const userId = actingUserOf(context);
  const teamIds = (await teamsOfMember(context, userId)).map(({ id }) => id);
  const side = accountableSideOf({ userId, teamIds }, await partiesOf(context, row));
  if (side === undefined) throw new Error("A commitment is proposed only by someone on a side of its request, which the side rules check first.");
  const teamId = await teamActedFor(context, userId, row);
  return context.write(
    async (writer) => {
      await writer.changesRequest(row.id);
      const createdAt = writer.now();
      const stamp = stampOf(writer.provenance, teamId);
      const [created] = await writer.tx
        .insert(proposals)
        .values({
          orgId: writer.orgId,
          requestId: row.id,
          kind: commitment.kind,
          secondConfirmation: secondConfirmation(commitment.commitments ?? [commitment.kind], side),
          accountableUserId: userId,
          accountableSide: side,
          actorKind: stamp.actorKind,
          client: stamp.client,
          surface: stamp.surface,
          teamId: stamp.teamId,
          change: commitment.change,
          baseRevision: commitment.baseRevision ?? null,
          createdAt,
          expiresAt: proposalExpiresAt(createdAt),
        })
        .returning({ id: proposals.id });
      if (created === undefined) throw new Error("The new proposal was not returned.");
      await writer.record(proposalCreated, { requestId: row.id, proposalId: created.id, kind: commitment.kind });
      return { proposal: await proposalView(writer, created.id) };
    },
    { teamId },
  );
}

/**
 * Cancels the request's pending proposals that a change to it cancels
 * (requests: How a proposal ends without taking effect; handoff-packet: Packet
 * changes that are commitments), in the change's own transaction, each with
 * its proposal.ended event: a terminal state cancels them all, a confirmed
 * reassignment every other one, a removal those of the removed accountable
 * human, and a new revision the packet changes based on an older one, as
 * stale. The pending proposals are locked first, so a confirmation that
 * arrives meanwhile waits and then finds the proposal ended.
 */
export async function cancelProposals(writer: Writer, requestId: string, change: ProposalCancellingChange): Promise<string[]> {
  const pending = await writer.tx
    .select({
      id: proposals.id,
      kind: proposals.kind,
      accountableUserId: proposals.accountableUserId,
      baseRevision: proposals.baseRevision,
    })
    .from(proposals)
    .where(and(eq(proposals.orgId, writer.orgId), eq(proposals.requestId, requestId), eq(proposals.state, "pending")))
    .orderBy(asc(proposals.createdAt), asc(proposals.id))
    .for("update");
  const cancelled = cancelledBy(
    change,
    pending.map((proposal) => ({ ...proposal, kind: proposal.kind as CommitmentKind })),
  );
  for (const { id, reason } of cancelled) {
    await writer.tx
      .update(proposals)
      .set({ state: "cancelled", cancelReason: reason, endedAt: writer.now() })
      .where(and(eq(proposals.orgId, writer.orgId), eq(proposals.id, id)));
    await writer.record(proposalEnded, { requestId, proposalId: id, how: "cancelled", reason });
  }
  return cancelled.map(({ id }) => id);
}

/** Refused as a record that does not exist. */
export function noSuchProposal(): Refusal {
  return new Refusal("record-not-found", "There is no such proposal.");
}

/** Users by id, as a proposal names them. */
async function usersNamed({ tx, orgId }: OrgContext, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  const rows =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: users.id, login: users.githubLogin, bot: users.bot })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(users.id, wanted)));
  const byId = new Map(rows.map(({ id, login, bot }) => [id, { id, login, kind: "human" as const, bot }]));
  return (id: string) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error("A proposal names a user the install does not have.");
    return found;
  };
}

/**
 * Cancels every pending proposal whose accountable human is a member being
 * removed, in the removal's transaction, each with its event (requests: A
 * removed member's claims stay and their proposals are cancelled). An admin's
 * removal calls it, and so will a removal for leaving the GitHub organization.
 */
export async function cancelProposalsOfRemovedMember(writer: Writer, userId: string): Promise<void> {
  const theirs = await writer.tx
    .selectDistinct({ requestId: proposals.requestId })
    .from(proposals)
    .where(and(eq(proposals.orgId, writer.orgId), eq(proposals.accountableUserId, userId), eq(proposals.state, "pending")));
  for (const { requestId } of theirs.sort((a, b) => a.requestId.localeCompare(b.requestId))) {
    await cancelProposals(writer, requestId, { kind: "member_removed", userId });
  }
}

/** One proposal as the operations return it; 404 when the install has no such proposal. */
export async function proposalView(context: OrgContext, proposalId: string): Promise<ProposalView> {
  const [row] = await context.tx
    .select({ proposal: proposals, request: requests })
    .from(proposals)
    .innerJoin(requests, and(eq(requests.orgId, proposals.orgId), eq(requests.id, proposals.requestId)))
    .where(and(eq(proposals.orgId, context.orgId), eq(proposals.id, proposalId)));
  if (row === undefined) throw noSuchProposal();
  const { proposal: stored, request } = row;
  const { id, key } = await requestView(context, stored.requestId);
  const received = await context.tx
    .select()
    .from(proposalConfirmations)
    .where(and(eq(proposalConfirmations.orgId, context.orgId), eq(proposalConfirmations.proposalId, stored.id)))
    .orderBy(asc(proposalConfirmations.confirmedAt));
  const userOf = await usersNamed(context, [stored.accountableUserId, ...received.map(({ userId }) => userId)]);
  const accountableHuman = userOf(stored.accountableUserId);
  const rules = stored.secondConfirmation as SecondConfirmer[];
  const change = stored.change as { packet?: Packet; teamId?: string };
  // The requester side's rule names the requesting team; the target team's and the claimant's, the target team.
  const teamIds = [rules.includes("requester_side") ? request.requestingTeamId : request.targetTeamId, ...(change.teamId === undefined ? [] : [change.teamId])];
  const teamRows = await context.tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, context.orgId), inArray(teams.id, teamIds)));
  const teamOf = (teamId: string) => teamRows.find((team) => team.id === teamId) ?? null;
  const reassignedTo = change.teamId === undefined ? null : teamOf(change.teamId);
  return {
    id: stored.id,
    request: { id, key },
    kind: stored.kind as CommitmentKind,
    state: stored.state as ProposalState,
    accountableHuman,
    proposedBy: {
      user: accountableHuman,
      actorKind: stored.actorKind as ProposalView["proposedBy"]["actorKind"],
      surface: stored.surface as ProposalView["proposedBy"]["surface"],
    },
    change: {
      // A due-date commitment is the one whose second confirmation comes from the other side of the accountable human's.
      ...(change.packet !== undefined && (rules.includes("target_team") || rules.includes("requester_side"))
        ? { dueDate: change.packet.due_date ?? null }
        : {}),
      ...(reassignedTo === null ? {} : { team: reassignedTo }),
    },
    confirmations: {
      needed: [
        { step: "accountable_human", user: accountableHuman, rules: [], team: null },
        ...(rules.length === 0 ? [] : [{ step: "other_side" as const, user: null, rules, team: teamOf(teamIds[0] ?? "") }]),
      ],
      received: received.map((confirmation) => ({
        step: confirmation.step as "accountable_human" | "other_side",
        user: userOf(confirmation.userId),
        confirmedAt: confirmation.confirmedAt.toISOString(),
      })),
    },
    createdAt: stored.createdAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
    endedAt: stored.endedAt === null ? null : stored.endedAt.toISOString(),
    cancelReason: stored.cancelReason as CancelReason | null,
    untrusted: { client: stored.client, packet: change.packet ?? null },
  };
}

export const PROPOSAL_HANDLERS: Handlers = {
  [getProposal.id]: defineHandler(getProposal, async ({ proposal }, context) => proposalView(context, proposal)),
};
