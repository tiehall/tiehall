import { getPacket, getPacketRevision } from "@tiehall/catalog";
import { defineHandler, type Handlers } from "./execute.ts";
import { packetRevisionOf } from "./packet-revisions.ts";
import { resolveRequestKey } from "./request-keys.ts";

// The packet operations (handoff-packet: Immutable, numbered revisions;
// handoff-packet: Open objects, strict server). Every member sees every
// request, and so its packet: the reads check no side.

export const PACKET_HANDLERS: Handlers = {
  [getPacket.id]: defineHandler(getPacket, async ({ key }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return packetRevisionOf(context, requestId);
  }),

  [getPacketRevision.id]: defineHandler(getPacketRevision, async ({ key, revision }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return packetRevisionOf(context, requestId, revision);
  }),
};
