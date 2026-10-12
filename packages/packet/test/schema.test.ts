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

  // decisions-from-groups-15-28, D55 (63): a developer may attach a diff of two refs that no pull request holds yet.
  it("accepts a request packet's contract section without a provider PR and status, and refuses a contract_change one without them", () => {
    const validate = packetValidator(schema);
    const section = {
      api: "payments-api",
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "refunds", sha: "b".repeat(40) },
      engine: { name: "oasdiff", version: "1.32.1" },
      changes: [{ id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" }],
    };
    const of = (kind: string, contract: Record<string, unknown>) => ({ schema_version: "1-beta", kind, untrusted: { need: "Review the change.", contract } });
    expect(validate(of("request", section))).toBe(true);
    expect(validate(of("contract_change", section))).toBe(false);
    expect(validate(of("contract_change", { ...section, provider_pr: { repository: "acme/payments", number: 310 }, provider_status: "open" }))).toBe(true);
  });

  // decisions-from-groups-15-28, D55 (83): the rule is a pattern, so a validator that skips formats, as this one does, keeps it.
  it("refuses a URL of another scheme than http and https in each URL field, though its validator skips formats", () => {
    const validate = packetValidator(schema);
    const withLink = (url: string) => ({ schema_version: "1-beta", kind: "request", untrusted: { need: "A need.", links: [{ url }] } });
    const withPullRequest = (url: string) => ({
      schema_version: "1-beta",
      kind: "contract_change",
      untrusted: {
        need: "A need.",
        contract: {
          api: "payments-api",
          base: { ref: "main", sha: "a".repeat(40) },
          head: { ref: "refunds", sha: "b".repeat(40) },
          engine: { name: "oasdiff", version: "1.32.1" },
          changes: [],
          provider_pr: { repository: "acme/payments", number: 310, url },
          provider_status: "open",
        },
      },
    });
    for (const url of ["javascript:alert(document.domain)", "data:text/html,<script>alert(1)</script>", "JavaScript:alert(1)", "ftp://files.example.com/specs"]) {
      expect(validate(withLink(url)), url).toBe(false);
      expect(validate(withPullRequest(url)), url).toBe(false);
    }
    for (const url of ["https://github.com/acme/payments/pull/310", "http://wiki.example.com/a", "HTTPS://github.com/acme/payments/pull/310"]) {
      expect(validate(withLink(url)), url).toBe(true);
      expect(validate(withPullRequest(url)), url).toBe(true);
    }
  });

  it("accepts a packet with a top-level key it does not define", () => {
    const validate = packetValidator(schema);
    const packet = { schema_version: "1-beta", kind: "request", untrusted: { need: "Add a dark mode." } };
    expect(validate(packet)).toBe(true);
    expect(validate({ ...packet, owner: "someone", untrusted: { ...packet.untrusted, mood: "hopeful" } })).toBe(true);
  });
});
