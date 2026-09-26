import schema from "@tiehall/packet/schema/v1-beta.json" with { type: "json" };

// The packet JSON Schema an install serves at /schemas/packet/v1-beta.json
// (handoff-packet: The beta label; design.md, Technical decisions: T11). It is
// the committed file of the Apache-2.0 schema directory, carried in the build
// rather than generated at run time, so every install of a release serves the
// same bytes. The file is written with sorted keys and two-space indents,
// which JSON.stringify keeps, so this text is the file itself; the packet
// schema check in CI keeps the file equal to what the packet definition
// generates.

export const PACKET_SCHEMA_JSON = `${JSON.stringify(schema, null, 2)}\n`;
