import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeDocument } from "./openapi.ts";
import { COMMITTED_PACKET_SCHEMA, packetJsonSchema } from "./packet-schema.ts";

// Writes packages/packet/schema/v1-beta.json, the packet JSON Schema in the
// Apache-2.0 schema directory, from the catalog's packet definition
// (handoff-packet: One definition for the schema and the API; design.md,
// Technical decisions: T11): `pnpm packet:generate`. Every change to the
// packet is then reviewed as a diff of this file.

mkdirSync(dirname(COMMITTED_PACKET_SCHEMA), { recursive: true });
writeFileSync(COMMITTED_PACKET_SCHEMA, serializeDocument(packetJsonSchema()));
console.log(`Wrote ${COMMITTED_PACKET_SCHEMA} from the catalog's packet definition.`);
