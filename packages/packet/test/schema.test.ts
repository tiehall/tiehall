import { describe, expect, it } from "vitest";
import { conformanceProblems, loadFixtures, runConformance } from "../src/conformance.ts";
import { packetValidator, readPacketSchema } from "../src/validator.ts";

// The packet JSON Schema of this directory (handoff-packet: The packet
// format; handoff-packet: The Apache-2.0 schema directory; handoff-packet: The
// beta label). The schema is JSON Schema draft 2020-12 with the beta $id, and
// the fixtures behave as labeled against it: every valid fixture validates and
// every invalid one fails, an unknown key included, which the schema allows.

describe("the packet JSON Schema", () => {
  const schema = readPacketSchema();

  it("is JSON Schema 2020-12 with the beta $id", () => {
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["$id"]).toBe("https://tiehall.com/schemas/packet/v1-beta.json");
  });

  it("names no other document", () => {
    const refs = JSON.stringify(schema).match(/"\$ref":"[^"]*"/g) ?? [];
    for (const ref of refs) expect(ref).toMatch(/^"\$ref":"#/);
  });

  it("accepts every valid fixture and refuses every invalid one", () => {
    expect(conformanceProblems(runConformance(packetValidator(schema), loadFixtures()))).toEqual([]);
  });

  it("accepts a packet with a top-level key it does not define", () => {
    const validate = packetValidator(schema);
    const packet = { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode." } };
    expect(validate(packet)).toBe(true);
    expect(validate({ ...packet, owner: "someone", untrusted: { ...packet.untrusted, mood: "hopeful" } })).toBe(true);
  });
});
