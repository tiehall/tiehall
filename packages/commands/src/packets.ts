import { addPacketRevision, getPacket, getPacketChanges, getPacketRevision, type Packet } from "@tiehall/catalog";
import { changedPacketFields, jsonPatch, packetCommitments, Refusal, sameJson } from "@tiehall/core";
import { agentJson } from "@tiehall/packet/render";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { packetRevisionOf, storePacketRevision, type PacketRevisionView } from "./packet-revisions.ts";
import type { ProposalAnswer } from "./proposals.ts";
import { actingUserOf, assertSideAllows, lockRequest, teamActedFor } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { assertRevisionKeepsRequiredFields, pendingReassignmentTeams, REQUIRED_FIELD_CHECKS, requiringTeamOf } from "./required-fields.ts";

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
// revision has, or one that the team of a pending reassignment of the request
// requires, is refused with 400 and creates nothing, and the reassignment
// stays pending (decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (41); required-fields.ts).
//
// A field whose new value is its current value as it was read is no change
// and keeps its stored text, and only such a value: the value as agents read
// it, without the characters the agent view strips, with any of its line
// breaks written as CR LF; or the stored value as the web UI's form shows it,
// with each of its line breaks, LF or CR LF, written as CR LF, as a browser
// sends a text area back. So a packet read and sent back changes only what its
// sender changed. A lone CR is no line break, as in the agent view, which
// removes it and makes no line break of it: a line break sent where a lone CR
// is stored, which agents read as nothing, and a lone CR sent where a line
// break is, are changes. Any other value is stored as it was sent, so an edit
// that adds only characters the agent view strips, the CR of a CR LF line
// break aside, is a change (agent-safety: Invisible characters are stripped
// from the agent view; handoff-packet: Open objects, strict server;
// decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (36); its design.md, Technical decisions: T5).
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
  // A revision, added or proposed, keeps every field that the current revision has and that the request's team
  // requires, or the team of a pending reassignment of it (D55 (41)).
  await assertRevisionKeepsRequiredFields(
    context,
    await requiringTeamOf(context, row.targetTeamId),
    await pendingReassignmentTeams(context, row.id, context.now()),
    current.packet as Packet,
    packet,
    (field) => (action === "propose_due_date" && field === "due_date" ? ["dueDate"] : REQUIRED_FIELD_CHECKS[field].path),
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
 * is its current value as it was read kept as it is stored: such a value is no
 * change, so a packet read and sent back changes only what its sender changed,
 * and the stored text keeps what was written, such as the carriage returns of
 * a web form's line breaks, which the agent view strips.
 */
function keptAsRead(current: Packet, packet: Packet): Packet {
  const before: Readonly<Record<string, unknown>> = current.untrusted;
  const untrusted = Object.fromEntries(
    Object.entries(packet.untrusted).map(([field, value]) => (Object.hasOwn(before, field) && readAs(value, before[field]) ? [field, before[field]] : [field, value])),
  );
  return { ...packet, untrusted } as Packet;
}

/**
 * Whether a value sent is the stored one as it was read: with its CR LF line
 * breaks as line feeds, it is the stored value as agents read it; or it is the
 * stored value with each of its line breaks written as CR LF, as the web UI's
 * form sends it back. A lone CR is no line break in either: the agent view
 * removes it, so one sent is never the value agents read, and one stored is
 * nothing to them, not a line break. Any other value is not the stored one,
 * such as one that adds to it only characters the agent view strips.
 */
function readAs(value: unknown, stored: unknown): boolean {
  return sameJson(withLineFeeds(value), agentJson(stored)) || sameJson(value, withCrLf(stored));
}

/** A JSON value with each CR LF line break of its strings written as a line feed; a lone CR, which is no line break, stays, and keys stay as they are. */
function withLineFeeds(value: unknown): unknown {
  return eachString(value, (text) => text.replace(/\r\n/g, "\n"));
}

/** A JSON value with each line break of its strings, a line feed or CR LF, written as CR LF; a lone CR, which is no line break, stays, and keys stay as they are. */
function withCrLf(value: unknown): unknown {
  return eachString(value, (text) => text.replace(/\r?\n/g, "\r\n"));
}

/** A JSON value with each of its strings written anew; keys stay as they are. */
function eachString(value: unknown, write: (text: string) => string): unknown {
  if (typeof value === "string") return write(value);
  if (Array.isArray(value)) return value.map((item) => eachString(item, write));
  if (value === null || typeof value !== "object") return value;
  // fromEntries defines each key as the object's own, so a key such as __proto__ in extensions stays a key.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, eachString(item, write)]));
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
