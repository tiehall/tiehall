import { describe, expect, it } from "vitest";
import { conformanceProblems, loadFixtures, runConformance } from "@tiehall/packet/conformance";
import { packet } from "../src/index.ts";

// The packet definition against the conformance fixtures (handoff-packet:
// Packet fields; handoff-packet: The packet format; handoff-packet: The
// Apache-2.0 schema directory). Every valid fixture of the Apache-2.0 schema
// directory passes the catalog's packet definition, and every invalid one
// fails it: a request packet and a contract packet validate, and a packet
// without a need and a contract-change packet without its contract section
// fail.

const validate = (value: unknown): boolean => packet.safeParse(value).success;

describe("the packet definition against the conformance fixtures", () => {
  for (const fixture of loadFixtures()) {
    it(`${fixture.expected === "valid" ? "accepts" : "refuses"} ${fixture.name}`, () => {
      expect(conformanceProblems(runConformance(validate, [fixture]))).toEqual([]);
    });
  }
});
