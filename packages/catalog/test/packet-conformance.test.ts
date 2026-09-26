import { describe, expect, it } from "vitest";
import { conformanceProblems, loadFixtures, runConformance } from "@tiehall/packet/conformance";
import * as catalog from "../src/index.ts";

// The packet definition against the conformance fixtures (handoff-packet:
// Packet fields; handoff-packet: The packet format; handoff-packet: The
// Apache-2.0 schema directory). Every valid fixture of the Apache-2.0 schema
// directory passes the catalog's packet definition, and every invalid one
// fails it: a request packet and a contract packet validate, and a packet
// without a need and a contract-change packet without its contract section
// fail. The catalog defines the packet from task 12.2 on; until then each
// case is an expected failure.

/** The catalog's packet definition, once it has one. */
const definition = (catalog as Record<string, unknown>)["packet"] as { safeParse(value: unknown): { success: boolean } } | undefined;

function validate(packet: unknown): boolean {
  if (definition === undefined) throw new Error("The catalog defines no packet yet.");
  return definition.safeParse(packet).success;
}

describe("the packet definition against the conformance fixtures", () => {
  for (const fixture of loadFixtures()) {
    it.fails(`${fixture.expected === "valid" ? "accepts" : "refuses"} ${fixture.name}`, () => {
      expect(conformanceProblems(runConformance(validate, [fixture]))).toEqual([]);
    });
  }
});
