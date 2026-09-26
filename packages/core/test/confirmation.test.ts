import { describe, expect, it } from "vitest";
import { canonicalJson, quotePreamble } from "../src/index.ts";

// The confirmation step's rules that need no I/O (agent-safety: The review page
// of the confirmation step; design.md, Self-hosting decisions: S7): a review
// quotes text Tiehall did not write under a preamble that names its origin,
// and an action's input is compared in canonical JSON.

describe("a quote's preamble", () => {
  it("names where the quoted text came from", () => {
    expect(quotePreamble("same team")).toBe("Text a member of your team wrote, quoted as data:");
    expect(quotePreamble("other team")).toBe("Text another team wrote, quoted as data:");
    expect(quotePreamble("external")).toBe("Text from outside Tiehall, quoted as data:");
  });
});

describe("canonical JSON", () => {
  it("writes every object's keys in order, at every depth, and a date as JSON does", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, when: new Date("2026-12-01T00:00:00Z") })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1,"when":"2026-12-01T00:00:00.000Z"}',
    );
  });
});
