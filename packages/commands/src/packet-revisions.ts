import type { Packet, packetRevision } from "@tiehall/catalog";
import { Refusal, requestPacketRevised } from "@tiehall/core";
import { packetRevisions } from "@tiehall/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { cancelProposals, lockPendingProposals } from "./proposals.ts";
import { lockRequestById, stampOf } from "./request-changes.ts";
import { requestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";
import type { Writer } from "./write.ts";

// A request's packet revisions (handoff-packet: Immutable, numbered
// revisions; handoff-packet: Open objects, strict server; requests: Events
// carry ids, not bodies). Each revision is a row that holds the packet as the
// catalog's definition parsed it, so only the keys the packet schema knows are
// stored, and the provenance of whoever added it. The packet a request is
// opened with is revision 1, and each change adds the next number: adding
// locks the request's row first, so revisions added at once take their numbers
// one after the other, and a number is never taken twice. A revision never
// changes once it is stored, which the database also refuses (migration 0020),
// and each stays readable by its number. A new revision cancels, as stale,
// every pending proposed packet change based on an older one, whoever or
// whatever added it (handoff-packet: Packet changes that are commitments);
// those proposals are locked with the request's row, before the write's first
// event, in the lock order (event-sequence.ts).

/** A packet revision as the packet operations return it. */
export type PacketRevisionView = z.input<typeof packetRevision>;

/** Refused as a record that does not exist. */
export function noSuchRevision(): Refusal {
  return new Refusal("record-not-found", "The request has no such packet revision.");
}

/** Stores a revision of the request's packet, as the caller's change, in the caller's transaction. */
export async function insertPacketRevision(
  { tx, orgId }: OrgContext,
  requestId: string,
  number: number,
  packet: Packet,
  stamp: ReturnType<typeof stampOf>,
): Promise<void> {
  await tx.insert(packetRevisions).values({ orgId, requestId, number, packet, ...stamp });
}

/**
 * Adds the next revision of the request's packet, with the write's provenance,
 * or, for a confirmed packet change, its proposer's, and the domain event that
 * names it; returns the new revision's number.
 */
export async function storePacketRevision(
  writer: Writer,
  requestId: string,
  packet: Packet,
  stamp?: ReturnType<typeof stampOf>,
): Promise<number> {
  await lockRequestById(writer, requestId);
  await lockPendingProposals(writer, requestId);
  await writer.changesRequest(requestId);
  const [latest] = await writer.tx
    .select({ number: sql<number>`coalesce(max(${packetRevisions.number}), 0)::int` })
    .from(packetRevisions)
    .where(and(eq(packetRevisions.orgId, writer.orgId), eq(packetRevisions.requestId, requestId)));
  const number = (latest?.number ?? 0) + 1;
  const { provenance } = writer;
  const stamped = stamp ?? stampOf(provenance, provenance.actorKind === "operator" ? undefined : provenance.teamId);
  await insertPacketRevision(writer, requestId, number, packet, stamped);
  await writer.record(requestPacketRevised, { requestId, revision: number });
  await cancelProposals(writer, requestId, { kind: "revision_added", revision: number });
  return number;
}

/** The request's packet at a revision, the current one unless a number is given; 404 when the request has no such revision. */
export async function packetRevisionOf(context: OrgContext, requestId: string, revision?: number): Promise<PacketRevisionView> {
  const { tx, orgId } = context;
  const [row] = await tx
    .select({ number: packetRevisions.number, packet: packetRevisions.packet, createdAt: packetRevisions.createdAt })
    .from(packetRevisions)
    .where(
      and(
        eq(packetRevisions.orgId, orgId),
        eq(packetRevisions.requestId, requestId),
        ...(revision === undefined ? [] : [eq(packetRevisions.number, revision)]),
      ),
    )
    .orderBy(desc(packetRevisions.number))
    .limit(1);
  if (row === undefined) throw noSuchRevision();
  const { id, key } = await requestView(context, requestId);
  return { request: { id, key }, revision: row.number, createdAt: row.createdAt.toISOString(), packet: row.packet as Packet };
}
