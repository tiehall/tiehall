import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
import { requestKey, requestRef } from "./requests.ts";

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
// What changed since a revision is the list of the fields that changed and an
// RFC 6902 JSON Patch from that revision to the current one (handoff-packet:
// What changed since revision N).

/** A revision of a request's packet, as the packet operations return it. */
export const packetRevision = z.object({
  request: requestRef,
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
  stability: "beta",
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
  stability: "beta",
  etag: "revision",
});

export const addPacketRevision = defineCommand({
  id: "packets.add_revision",
  summary:
    "Add the next revision of a request's packet, as its requester side, naming the revision you expect in If-Match; a revision keeps the packet's kind. Setting or moving the due date, and changing the need, the acceptance criteria or the contract section of a claimed request, are commitments: they create a proposal based on the revision you expect, answered with 202, which people confirm in the web UI.",
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
  commitment: true,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
  ifMatch: "expectedRevision",
  etag: "revision",
});

/** The form of a packet field's name, such as acceptance_criteria. */
export const PACKET_FIELD_NAME = /^[a-z][a-z_]*$/;

/** One operation of an RFC 6902 JSON Patch, of the three kinds Tiehall's patches use. */
const jsonPatchOperation = z.object({
  op: z.enum(["add", "remove", "replace"]),
  path: z.string().meta({ description: "An RFC 6901 JSON Pointer into the packet." }),
  value: z.unknown().optional().meta({ description: "For add and replace, the value." }),
});

export const getPacketChanges = defineCommand({
  id: "packets.changes",
  summary:
    "Say what changed in a request's packet since a revision: the fields that changed, and an RFC 6902 JSON Patch that turns that revision's packet into the current one. Both are empty since the current revision.",
  input: z.object({
    key: requestKey,
    since: z.coerce.number().int().min(1).meta({ description: "The revision to compare the current one with." }),
  }),
  output: z.object({
    request: requestRef,
    since: z.number().int().min(1),
    /** The current revision. */
    revision: z.number().int().min(1),
    /** The packet's fields that changed, such as acceptance_criteria and links. */
    changedFields: z.array(z.string().regex(PACKET_FIELD_NAME)),
    /** The patch holds what people wrote, so it sits under untrusted. */
    untrusted: z.object({ patch: z.array(jsonPatchOperation) }),
  }),
  method: "GET",
  path: "/api/v1/requests/{key}/packet/changes",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
});

export const PACKET_COMMANDS = [getPacket, getPacketRevision, addPacketRevision, getPacketChanges];
