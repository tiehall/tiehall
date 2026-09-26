import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

// Validating a packet against the packet JSON Schema (handoff-packet: The
// packet format; handoff-packet: The beta label). The schema is draft 2020-12
// and names no other document, so validating needs nothing but the schema
// itself: nothing is fetched, from tiehall.com or anywhere else. The schema's
// own annotation for untrusted fields, x-tiehall-untrusted, is a keyword the
// validator knows and ignores; formats are left to the patterns the schema
// gives alongside them, so every validator reads a date the same way.

/** The committed packet JSON Schema, schema/v1-beta.json. */
export const SCHEMA_FILE = new URL("../schema/v1-beta.json", import.meta.url);

/** The packet JSON Schema, as the file holds it. */
export function readPacketSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
}

/** A validator for packets against a packet JSON Schema, the committed one unless another is given. */
export function packetValidator(schema: Record<string, unknown> = readPacketSchema()): (packet: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false, allErrors: false });
  ajv.addKeyword({ keyword: "x-tiehall-untrusted", schemaType: "boolean" });
  const validate = ajv.compile(schema);
  return (packet) => validate(packet);
}
