import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { packet, PACKET_KINDS, PACKET_SCHEMA_VERSION, UNTRUSTED_MARK } from "../src/index.ts";

// The packet, defined once in the catalog (handoff-packet: Packet fields;
// handoff-packet: User-written fields are marked untrusted; handoff-packet:
// The beta label; design.md, Technical decisions: T11). A packet carries its
// schema version, "1-beta" until the schema is published, and its kind, a
// request or a contract change; its due date; and, under `untrusted`, every
// field whose content a user, an agent or another system writes: the need,
// the acceptance criteria, code refs, links, the contract section and
// `extensions`. Each of those is also marked untrusted in the schema.

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`../../packet/fixtures/${name}`, import.meta.url), "utf8")) as Json;
}

const schema = z.toJSONSchema(packet, { target: "draft-2020-12", io: "input" }) as Json;
/** The packet's variants in its schema, one per kind. */
const variants = (schema["oneOf"] ?? schema["anyOf"]) as Json[];

describe("the beta label", () => {
  it("is 1-beta, the only schema_version a packet may carry before publication", () => {
    expect(PACKET_SCHEMA_VERSION).toBe("1-beta");
    const parsed = packet.parse(fixture("valid/minimal-request-packet.json"));
    expect(parsed.schema_version).toBe("1-beta");
    for (const version of ["1.0", "1", "1-BETA"]) {
      expect(packet.safeParse({ ...fixture("valid/minimal-request-packet.json"), schema_version: version }).success, version).toBe(false);
    }
    for (const variant of variants) expect((variant["properties"] as Json)["schema_version"]).toMatchObject({ const: "1-beta" });
  });
});

describe("the packet's fields", () => {
  it("keeps a request packet's need, acceptance criteria, code refs, links and due date each in its own field", () => {
    const parsed = packet.parse(fixture("valid/request-packet.json"));
    expect(parsed).toEqual({
      schema_version: "1-beta",
      kind: "request",
      due_date: "2026-10-15",
      untrusted: {
        need: "The settings page needs a dark mode that follows the operating system's setting.",
        acceptance_criteria: [
          "The settings page follows the operating system's light or dark setting.",
          "A person can override the setting, and the override is kept across sessions.",
        ],
        code_refs: [{ repository: "acme/web", path: "src/settings/theme.ts", ref: "main" }],
        links: [{ url: "https://design.example.com/specs/dark-mode", title: "Dark mode design" }],
      },
    });
  });

  it("gives a contract packet its API, refs and shas, engine, changes, provider PR and status, migration notes and deprecation window", () => {
    const parsed = packet.parse(fixture("valid/contract-packet.json"));
    expect(parsed.kind).toBe("contract_change");
    expect(parsed.untrusted.contract).toEqual({
      api: "payments-api",
      base: { ref: "main", sha: "3f6c2a9e8b7d4c1f0a5e9d8c7b6a5f4e3d2c1b0a" },
      head: { ref: "remove-legacy-amount", sha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b" },
      engine: { name: "oasdiff", version: "1.32.0" },
      changes: [
        { id: "response-property-removed", level: "ERR", operation: "GET /payments/{id}" },
        { id: "response-property-removed", level: "ERR", operation: "GET /payments" },
        { id: "endpoint-deprecated", level: "INFO", operation: "GET /payments" },
      ],
      provider_pr: { repository: "acme/payments", number: 310, url: "https://github.com/acme/payments/pull/310" },
      provider_status: "open",
      migration_notes: "Read amount_minor and currency instead of amount and currency_code.",
      deprecation_window: { start: "2026-10-01", end: "2026-12-01" },
    });
  });

  it("requires the need in every packet, and the contract section in a contract-change packet only", () => {
    const need = { need: "Expose the invoice total." };
    expect(packet.safeParse({ schema_version: "1-beta", kind: "request", untrusted: need }).success).toBe(true);
    expect(packet.safeParse({ schema_version: "1-beta", kind: "request", untrusted: { acceptance_criteria: ["A total."] } }).success).toBe(false);
    expect(packet.safeParse({ schema_version: "1-beta", kind: "contract_change", untrusted: need }).success).toBe(false);
    for (const variant of variants) {
      const kind = ((variant["properties"] as Record<string, Json>)["kind"] as Json)["const"];
      const required = ((variant["properties"] as Record<string, Json>)["untrusted"] as Json)["required"];
      expect(required, String(kind)).toEqual(kind === "contract_change" ? ["need", "contract"] : ["need"]);
    }
    expect(variants.map((variant) => ((variant["properties"] as Record<string, Json>)["kind"] as Json)["const"])).toEqual([...PACKET_KINDS]);
  });

  it("refuses a known field of the wrong type", () => {
    const base = fixture("valid/request-packet.json");
    const untrusted = base["untrusted"] as Json;
    for (const [field, value] of [
      ["acceptance_criteria", "One criterion."],
      ["code_refs", [{ path: "src/a.ts" }]],
      ["links", [{ url: "not a url" }]],
      ["need", 42],
    ] as const) {
      expect(packet.safeParse({ ...base, untrusted: { ...untrusted, [field]: value } }).success, field).toBe(false);
    }
    expect(packet.safeParse({ ...base, due_date: "2026-02-30" }).success).toBe(false);
  });
});

describe("user-written fields", () => {
  it("sit under untrusted, which the schema marks, and each of them is marked too", () => {
    for (const variant of variants) {
      const properties = variant["properties"] as Record<string, Json>;
      const untrusted = properties["untrusted"] as Json;
      expect(untrusted[UNTRUSTED_MARK]).toBe(true);
      const fields = untrusted["properties"] as Record<string, Json>;
      expect(Object.keys(fields).sort()).toEqual(["acceptance_criteria", "code_refs", "contract", "extensions", "links", "need"]);
      for (const [name, field] of Object.entries(fields)) expect(field[UNTRUSTED_MARK], name).toBe(true);
    }
  });

  it("leave outside untrusted only the version, the kind and the due date, which hold no text of anyone's", () => {
    for (const variant of variants) {
      const properties = variant["properties"] as Record<string, Json>;
      expect(Object.keys(properties).sort()).toEqual(["due_date", "kind", "schema_version", "untrusted"]);
      expect(properties["schema_version"]).toMatchObject({ const: "1-beta" });
      expect(properties["kind"]).toHaveProperty("const");
      expect(properties["due_date"]).toMatchObject({ type: "string", format: "date" });
    }
  });

  it("include the contents of extensions", () => {
    const parsed = packet.parse(fixture("valid/extensions.json"));
    expect(parsed.untrusted.extensions).toEqual({
      "com.acme.billing": { cost_center: "CC-12", flags: ["urgent"] },
      "io.example.tracker": { ticket: 4821, labels: { area: "billing", risk: null } },
    });
  });
});
