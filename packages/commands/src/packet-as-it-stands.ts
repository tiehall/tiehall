import { PACKET_SCHEMA_VERSION, type Packet } from "@tiehall/catalog";

// A stored packet as the schema stands now (handoff-packet: The beta label;
// design.md, Decisions this change rests on: D28 #22). From the schema's
// publication on, every packet carries schema_version "1.0", also one the
// install stored while the schema was beta, whose fields the publication left
// as they were: the schema is published only after four weeks without a
// breaking packet change (handoff-packet: When the schema is published). The
// reads of stored packets and proposed packets, and the writing of a new
// revision, go through it, so a packet stored before publication reads back as
// a packet of 1.0 and every revision stored after it carries 1.0. Before
// publication it changes nothing.

/** A stored packet, with the schema_version packets carry now. */
export function packetAsItStands(stored: unknown): Packet {
  return { ...(stored as Packet), schema_version: PACKET_SCHEMA_VERSION };
}
