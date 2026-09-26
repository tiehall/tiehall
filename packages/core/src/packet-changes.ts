// What a change to a request's packet touches, and which of it are
// commitments (handoff-packet: Packet changes that are commitments;
// handoff-packet: What changed since revision N; design.md, Decisions this
// change rests on: D23; D28 #14, #15). A pure module. A packet's fields are
// its kind and due date at its top level, and the fields under its
// `untrusted` object: the need, the acceptance criteria, code refs, links, the
// contract section and extensions. Two values of a field are the same when
// they are the same JSON, whatever the order of an object's keys.
//
// Scope is the need, the acceptance criteria and the contract section. These
// changes are commitments, which a person confirms: setting, moving or
// removing the due date after the request was opened, and a change to scope
// while the request is claimed, meaning it has a claimant at that moment. Any
// other change, a scope change while the request is unclaimed included, is not.

import { sameJson } from "./json-patch.ts";

/** A packet as the rules see it: its top-level values and the fields under untrusted. */
export interface PacketContent {
  schema_version?: unknown;
  kind?: unknown;
  due_date?: unknown;
  untrusted: Readonly<Record<string, unknown>>;
}

/** The fields that make a request's scope. */
export const SCOPE_FIELDS = ["need", "acceptance_criteria", "contract"] as const;

/** The packet's own fields, top level first, in the order a list of changed fields names them. */
export const PACKET_FIELDS = ["kind", "due_date", "need", "acceptance_criteria", "code_refs", "links", "contract", "extensions"] as const;
const TOP_LEVEL_FIELDS: readonly string[] = ["kind", "due_date"];

/** A packet change that is a commitment: the due date, or scope while the request is claimed. */
export type PacketCommitment = "due_date" | "scope";

/** The packet's fields whose values differ between two packets, in the order of PACKET_FIELDS, then any other field by name. */
export function changedPacketFields(before: PacketContent, after: PacketContent): string[] {
  const valueOf = (packet: PacketContent, field: string): unknown =>
    TOP_LEVEL_FIELDS.includes(field) ? (packet as unknown as Record<string, unknown>)[field] : packet.untrusted[field];
  const others = [...new Set([...Object.keys(before.untrusted), ...Object.keys(after.untrusted)])]
    .filter((field) => !(PACKET_FIELDS as readonly string[]).includes(field))
    .sort();
  return [...PACKET_FIELDS, ...others].filter((field) => !sameJson(valueOf(before, field), valueOf(after, field)));
}

/** The commitments a change from one packet to the next makes, for a request that is claimed or not. */
export function packetCommitments(before: PacketContent, after: PacketContent, claimed: boolean): PacketCommitment[] {
  const fields = changedPacketFields(before, after);
  const commitments: PacketCommitment[] = [];
  if (fields.includes("due_date")) commitments.push("due_date");
  if (claimed && fields.some((field) => (SCOPE_FIELDS as readonly string[]).includes(field))) commitments.push("scope");
  return commitments;
}
