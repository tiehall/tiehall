import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
import { requestKey } from "./requests.ts";

// The operations on a request's packet (handoff-packet: Immutable, numbered
// revisions; handoff-packet: Open objects, strict server; handoff-packet: One
// definition for the schema and the API; public-api: Packet revisions use ETag
// and If-Match). A request's packet is kept as numbered revisions, the first
// being the packet the request was opened with. Every member can read every
// request, and so its packet; a read answers with the ETag of the revision it
// returns, such as "3". The requester side adds the next revision, naming the
// revision it expects: on REST in If-Match, as that revision's ETag. Each
// operation takes and returns the packet as the one component Packet; a packet
// reads back as Tiehall parsed it, without the keys the schema does not know.

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
  etag: "revision",
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
  etag: "revision",
});

export const addPacketRevision = defineCommand({
  id: "packets.add_revision",
  summary:
    "Add the next revision of a request's packet, as its requester side, naming the revision you expect in If-Match; a revision keeps the packet's kind. Setting or moving the due date, and changing the scope of a claimed request, are commitments this operation does not take yet.",
  input: z.object({
    key: requestKey,
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: "The revision you expect to be current; REST takes it from If-Match, as that revision's ETag." }),
    packet,
  }),
  output: packetRevision,
  method: "POST",
  path: "/api/v1/requests/{key}/packet/revisions",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
  ifMatch: "expectedRevision",
  etag: "revision",
});

export const PACKET_COMMANDS = [getPacket, getPacketRevision, addPacketRevision];
