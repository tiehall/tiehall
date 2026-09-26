import type { proposal } from "@tiehall/catalog";
import {
  accountableSideOf,
  proposalCreated,
  proposalExpiresAt,
  secondConfirmation,
  type CommitmentKind,
  type ProposalState,
} from "@tiehall/core";
import { proposals, users } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { HandlerContext } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf, partiesOf, stampOf, teamActedFor } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";
import { requestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

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

/** One proposal as the operations return it. */
export async function proposalView(context: OrgContext, proposalId: string): Promise<ProposalView> {
  const [row] = await context.tx
    .select({ proposal: proposals, login: users.githubLogin, bot: users.bot })
    .from(proposals)
    .innerJoin(users, and(eq(users.orgId, proposals.orgId), eq(users.id, proposals.accountableUserId)))
    .where(and(eq(proposals.orgId, context.orgId), eq(proposals.id, proposalId)));
  if (row === undefined) throw new Error("A proposal the install does not have was named.");
  const { proposal: stored } = row;
  const { id, key } = await requestView(context, stored.requestId);
  return {
    id: stored.id,
    request: { id, key },
    kind: stored.kind as CommitmentKind,
    state: stored.state as ProposalState,
    accountableHuman: { id: stored.accountableUserId, login: row.login, kind: "human", bot: row.bot },
    createdAt: stored.createdAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
  };
}
