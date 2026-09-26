import { addPacketRevision, getPacket, getPacketChanges, getPacketRevision } from "@tiehall/catalog";
import { changedPacketFields, jsonPatch, packetCommitments, Refusal } from "@tiehall/core";
import { defineHandler, type Handlers } from "./execute.ts";
import { packetRevisionOf, storePacketRevision } from "./packet-revisions.ts";
import { actingUserOf, assertSideAllows, lockRequest, teamActedFor } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";

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
// scope of a claimed request, are commitments, which become proposals with
// task 14.4; until then they get 409 and add nothing, so no commitment takes
// effect without the people who confirm it. The revision and its event commit
// together, with the requester side's team as the team the user acted for.
//
// What changed since revision N (handoff-packet: What changed since revision
// N): the fields that differ between revision N and the current revision, and
// the RFC 6902 JSON Patch that turns the one into the other, under untrusted,
// because it carries what people wrote. A revision the request does not have
// gets 404.

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

  [addPacketRevision.id]: defineHandler(addPacketRevision, async ({ key, expectedRevision, packet }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    await assertSideAllows(context, userId, row, "add_revision");
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
    if (packet.kind !== current.packet.kind) {
      const message = `A revision keeps the packet's kind, which is ${current.packet.kind}.`;
      throw new Refusal("invalid-input", message, { issues: [{ path: ["packet", "kind"], message }] });
    }
    const commitments = packetCommitments(current.packet, packet, row.claimantUserId !== null);
    if (commitments.includes("due_date")) {
      throw new Refusal(
        "conflict",
        "Setting or moving the due date after the request was opened is a commitment that people confirm in the web UI; this operation does not take it yet.",
      );
    }
    if (commitments.includes("scope")) {
      throw new Refusal(
        "conflict",
        "Changing the need, the acceptance criteria or the contract section of a claimed request is a commitment that people confirm in the web UI; this operation does not take it yet.",
      );
    }
    const teamId = await teamActedFor(context, userId, row);
    return context.write(async (writer) => packetRevisionOf(writer, row.id, await storePacketRevision(writer, row.id, packet)), { teamId });
  }),
};
