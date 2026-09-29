import { readFileSync } from "node:fs";
import { committedDocumentPath, committedPacketSchemaPath } from "./committed-files.ts";
import { packetSchemaDrift, packetSchemaProblems } from "./packet-schema.ts";

// CI's check of the packet schema (handoff-packet: One definition for the
// schema and the API; handoff-packet: Open objects, strict server): `pnpm
// check:packet-schema`. The committed schema file is the one the packet
// definition generates; it and the committed OpenAPI document's packet
// component define the same fields with the same types; no object of the
// schema forbids additional properties; and every operation that takes or
// returns a packet uses the one component Packet.

const committed = readFileSync(committedPacketSchemaPath(), "utf8");
const drift = packetSchemaDrift(committed);
const problems = [
  ...(drift === undefined ? [] : [drift]),
  ...packetSchemaProblems(JSON.parse(committed) as Record<string, unknown>, JSON.parse(readFileSync(committedDocumentPath(), "utf8")) as Record<string, unknown>),
];
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("packages/packet/schema/v1-beta.json is the packet definition's schema, and openapi/v1.json's one packet component matches it.");
