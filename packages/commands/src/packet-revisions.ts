import type { Packet, packetRevision } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { packetRevisions } from "@tiehall/db";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { stampOf } from "./request-changes.ts";
import { requestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// A request's packet revisions (handoff-packet: Immutable, numbered
// revisions; handoff-packet: Open objects, strict server). Each revision is a
// row that holds the packet as the catalog's definition parsed it, so only the
// keys the packet schema knows are stored, and the provenance of whoever added
// it. The packet a request is opened with is revision 1.

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

/** The request's packet at its current revision; 404 when the request has none. */
export async function currentPacketOf(context: OrgContext, requestId: string): Promise<PacketRevisionView> {
  const { tx, orgId } = context;
  const [row] = await tx
    .select({ number: packetRevisions.number, packet: packetRevisions.packet, createdAt: packetRevisions.createdAt })
    .from(packetRevisions)
    .where(and(eq(packetRevisions.orgId, orgId), eq(packetRevisions.requestId, requestId)))
    .orderBy(desc(packetRevisions.number))
    .limit(1);
  if (row === undefined) throw noSuchRevision();
  const { id, key } = await requestView(context, requestId);
  return { request: { id, key }, revision: row.number, createdAt: row.createdAt.toISOString(), packet: row.packet as Packet };
}
