import { addPacketRevision, getPacket, getPacketChanges, getPacketRevision, type Packet } from "@tiehall/catalog";
import { changedPacketFields, jsonPatch, packetCommitments, Refusal, sameJson } from "@tiehall/core";
import { teams } from "@tiehall/db";
import { agentJson } from "@tiehall/packet/render";
import { and, eq } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { packetRevisionOf, storePacketRevision, type PacketRevisionView } from "./packet-revisions.ts";
import type { ProposalAnswer } from "./proposals.ts";
import { actingUserOf, assertSideAllows, lockRequest, teamActedFor } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { assertRevisionKeepsRequiredFields, REQUIRED_FIELD_CHECKS, type RequiringTeam } from "./required-fields.ts";

// The packet operations (handoff-packet: Immutable, numbered revisions;
// handoff-packet: Open objects, strict server; handoff-packet: Packet changes
// that are commitments; public-api: Packet revisions use ETag and If-Match;
// requests: Which side may act on a request; design.md, Decisions this change
// rests on: D23; D28 #3, #21). Every member sees every request, and so its
// packet: the reads check no side.
//
// Adding a revision: the request's row is locked first, so writers take turns.
// Only the requester side may add one; anyone else gets 403. The caller names
// the revision it expects, which REST takes from If-Match: none gets 428, and
// one that is no longer current 412, so of two writers at the same revision
// only the first adds one. A revision keeps the packet's kind, so a
// contract-change request's packet keeps its contract section; a change of
// kind gets 400. Setting, moving or removing the due date, and changing the
// scope of a claimed request, are commitments: the change becomes a proposal,
// based on the revision the caller expects, and adds no revision, so no
// commitment takes effect without the people who confirm it. A change that is
// both is one proposal, whose second confirmation meets both rules. Any other
// change is added at once: the revision and its event commit together, with
// the requester side's team as the team the user acted for. A revision, added
// or proposed, that drops a field the request's team requires and the current
// revision has is refused with 400 and creates nothing
// (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (41); required-fields.ts). A field whose new value reads, as agents
// read it, the same as its current value is no change and keeps its stored
// text, so an agent that sends back the packet it read, without the
// characters the agent view strips, changes only what it changed
// (agent-safety: Invisible characters are stripped from the agent view;
// decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (36)).
//
// What changed since revision N (handoff-packet: What changed since revision
// N): the fields that differ between revision N and the current revision, and
// the RFC 6902 JSON Patch that turns the one into the other, under untrusted,
// because it carries what people wrote. A revision the request does not have
// gets 404.

/**
 * Adds the next revision of the request's packet for the user the call acts
 * for, or proposes it, as the requester side, naming the revision it expects:
 * the packet the call makes from the current one, as it reads it with the
 * request's row locked. Both packets.add_revision and the propose tool change
 * a packet through it, so either refuses a missing or stale expected revision
 * the same way. A due date is the one change either side may propose
 * (requests: Which side may act on a request): the propose tool's due date
 * asks for that right instead, and a change it makes that is no commitment,
 * such as the due date the packet has already, is a revision, which only the
 * requester side adds.
 */
export async function revisePacket(
  context: HandlerContext,
  key: string,
  expectedRevision: number | undefined,
  next: (current: Packet) => Packet,
  action: "add_revision" | "propose_due_date" = "add_revision",
): Promise<PacketRevisionView | ProposalAnswer> {
  const userId = actingUserOf(context);
  const row = await lockRequest(context, key);
  await assertSideAllows(context, userId, row, action);
  if (expectedRevision === undefined) {
    throw new Refusal(
      "if-match-required",
      'Adding a revision names the revision you expect: send If-Match with the ETag of the packet\'s current revision, such as "3".',
    );
  }
  const current = await packetRevisionOf(context, row.id);
  if (current.revision !== expectedRevision) {
    throw new Refusal(
      "precondition-failed",
      `The packet is at revision ${current.revision}, not ${expectedRevision}: read it again and send its ETag in If-Match.`,
    );
  }
  const packet = keptAsRead(current.packet as Packet, next(current.packet as Packet));
  if (packet.kind !== current.packet.kind) {
    const message = `A revision keeps the packet's kind, which is ${current.packet.kind}.`;
    throw new Refusal("invalid-input", message, { issues: [{ path: ["packet", "kind"], message }] });
  }
  // A revision, added or proposed, keeps every field the request's team requires that the current revision has (D55 (41)).
  await assertRevisionKeepsRequiredFields(context, await targetTeamOf(context, row.targetTeamId), current.packet as Packet, packet, (field) =>
    action === "propose_due_date" && field === "due_date" ? ["dueDate"] : REQUIRED_FIELD_CHECKS[field].path,
  );
  const commitments = packetCommitments(current.packet, packet, row.claimantUserId !== null);
  if (action === "propose_due_date" && !commitments.includes("due_date")) await assertSideAllows(context, userId, row, "add_revision");
  if (commitments.length > 0) {
    return context.propose(row, {
      kind: commitments.includes("scope") ? "scope" : "due_date",
      commitments,
      change: { packet },
      baseRevision: current.revision,
    });
  }
  const teamId = await teamActedFor(context, userId, row);
  return context.write(async (writer) => packetRevisionOf(writer, row.id, await storePacketRevision(writer, row.id, packet)), { teamId });
}

/**
 * The packet a change makes, with each field under untrusted whose new value
 * reads, as agents read it, the same as its current value kept as it is
 * stored: such a value is no change, so a packet read and sent back changes
 * only what its sender changed, and the stored text keeps the characters the
 * agent view strips, such as the carriage returns of a web form's line breaks.
 */
function keptAsRead(current: Packet, packet: Packet): Packet {
  const before: Readonly<Record<string, unknown>> = current.untrusted;
  const untrusted = Object.fromEntries(
    Object.entries(packet.untrusted).map(([field, value]) =>
      Object.hasOwn(before, field) && sameJson(agentJson(value), agentJson(before[field])) ? [field, before[field]] : [field, value],
    ),
  );
  return { ...packet, untrusted } as Packet;
}

/** The team a request is addressed to, by its id and its current key. */
async function targetTeamOf({ tx, orgId }: HandlerContext, teamId: string): Promise<RequiringTeam> {
  const [row] = await tx.select({ id: teams.id, key: teams.key }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
  if (row === undefined) throw new Error("A request is addressed to a team the install does not have.");
  return row;
}

export const PACKET_HANDLERS: Handlers = {
  [getPacket.id]: defineHandler(getPacket, async ({ key }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return packetRevisionOf(context, requestId);
  }),

  [getPacketRevision.id]: defineHandler(getPacketRevision, async ({ key, revision }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return packetRevisionOf(context, requestId, revision);
  }),

  [getPacketChanges.id]: defineHandler(getPacketChanges, async ({ key, since }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    const from = await packetRevisionOf(context, requestId, since);
    const current = await packetRevisionOf(context, requestId);
    return {
      request: current.request,
      since,
      revision: current.revision,
      changedFields: changedPacketFields(from.packet, current.packet),
      untrusted: { patch: jsonPatch(from.packet, current.packet) },
    };
  }),

  [addPacketRevision.id]: defineHandler(addPacketRevision, async ({ key, expectedRevision, packet }, context) =>
    revisePacket(context, key, expectedRevision, () => packet),
  ),
};
