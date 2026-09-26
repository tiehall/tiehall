import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
import { requestKey } from "./requests.ts";

// The operations on a request's packet (handoff-packet: Immutable, numbered
// revisions; handoff-packet: Open objects, strict server; handoff-packet: One
// definition for the schema and the API). A request's packet is kept as
// numbered revisions, the first being the packet the request was opened with.
// Every member can read every request, and so its packet. Each operation
// takes and returns the packet as the one component Packet; a packet reads
// back as Tiehall parsed it, without the keys the schema does not know.

/** A revision of a request's packet, as the packet operations return it. */
export const packetRevision = z.object({
  request: z.object({ id: z.uuid(), key: z.string() }),
  /** The revision's number, from 1 for the packet the request was opened with. */
  revision: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  packet,
});

export const getPacket = defineCommand({
  id: "packets.get",
  summary: "Read a request's packet at its current revision.",
  input: z.object({ key: requestKey }),
  output: packetRevision,
  method: "GET",
  path: "/api/v1/requests/{key}/packet",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const getPacketRevision = defineCommand({
  id: "packets.get_revision",
  summary: "Read a revision of a request's packet by its number; a revision never changes once it is added.",
  input: z.object({
    key: requestKey,
    revision: z.coerce.number().int().min(1).meta({ description: "The revision's number, from 1 for the packet the request was opened with." }),
  }),
  output: packetRevision,
  method: "GET",
  path: "/api/v1/requests/{key}/packet/revisions/{revision}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const PACKET_COMMANDS = [getPacket, getPacketRevision];
