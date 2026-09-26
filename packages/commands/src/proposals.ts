import type { proposal } from "@tiehall/catalog";
import {
  accountableSideOf,
  cancelledBy,
  proposalCreated,
  proposalEnded,
  proposalExpiresAt,
  secondConfirmation,
  type CommitmentKind,
  type ProposalCancellingChange,
  type ProposalState,
  type SecondConfirmer,
} from "@tiehall/core";
import { proposals, requests, teams, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { HandlerContext } from "./execute.ts";
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

/** One proposal as the operations return it. */
export async function proposalView(context: OrgContext, proposalId: string): Promise<ProposalView> {
  const [row] = await context.tx
    .select({ proposal: proposals, login: users.githubLogin, bot: users.bot, request: requests })
    .from(proposals)
    .innerJoin(users, and(eq(users.orgId, proposals.orgId), eq(users.id, proposals.accountableUserId)))
    .innerJoin(requests, and(eq(requests.orgId, proposals.orgId), eq(requests.id, proposals.requestId)))
    .where(and(eq(proposals.orgId, context.orgId), eq(proposals.id, proposalId)));
  if (row === undefined) throw new Error("A proposal the install does not have was named.");
  const { proposal: stored, request } = row;
  const { id, key } = await requestView(context, stored.requestId);
  const accountableHuman = { id: stored.accountableUserId, login: row.login, kind: "human" as const, bot: row.bot };
  const rules = stored.secondConfirmation as SecondConfirmer[];
  // The requester side's rule names the requesting team; the target team's and the claimant's, the target team.
  const teamId = rules.includes("requester_side") ? request.requestingTeamId : request.targetTeamId;
  const [team] = await context.tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, context.orgId), eq(teams.id, teamId)));
  return {
    id: stored.id,
    request: { id, key },
    kind: stored.kind as CommitmentKind,
    state: stored.state as ProposalState,
    accountableHuman,
    confirmations: {
      needed: [
        { step: "accountable_human", user: accountableHuman, rules: [], team: null },
        ...(rules.length === 0 ? [] : [{ step: "other_side" as const, user: null, rules, team: team ?? null }]),
      ],
      received: [],
    },
    createdAt: stored.createdAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
  };
}
