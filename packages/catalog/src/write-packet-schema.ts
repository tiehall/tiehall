import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeDocument } from "./openapi.ts";
import { committedPacketSchemaPath } from "./committed-files.ts";
import { packetJsonSchema } from "./packet-schema.ts";

// Writes packages/packet/schema/v1-beta.json, the packet JSON Schema in the
// Apache-2.0 schema directory, from the catalog's packet definition
// (handoff-packet: One definition for the schema and the API; design.md,
// Technical decisions: T11): `pnpm packet:generate`. Every change to the
// packet is then reviewed as a diff of this file.

const path = committedPacketSchemaPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, serializeDocument(packetJsonSchema()));
console.log(`Wrote ${path} from the catalog's packet definition.`);
