import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPacketForward, schemaChanges, type ForwardInput, type PacketRelease } from "../src/packet-forward.ts";

// The packet's forward compatibility after publication (handoff-packet: v1
// only gains optional fields after publication; design.md, Design rules:
// Handoff packet). Once v1.0 is published, a v1.x release only adds optional
// fields: it adds no required field, removes no field and changes no
// constraint of a field an older release defines, since a narrower constraint
// would refuse an older packet and a wider one would let a newer packet fail
// an older release. So a packet built against the newer release validates
// against every older one, and every conformance fixture that ever validated
// against a release still validates. The check compares the candidate, the
// schema the next release would publish, with every published release, and
// runs the fixtures both ways.
//
// No release is published yet, so the tests simulate one: v1.0 is the
// committed schema as its publication would make it, with schema_version
// "1.0" and its release URL as $id, and the fixtures carry "1.0".

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-packet-forward.ts", import.meta.url));
const COMMITTED = readFileSync(new URL("../../../packages/packet/schema/v1-beta.json", import.meta.url), "utf8");
const VALID_FOLDER = new URL("../../../packages/packet/fixtures/valid/", import.meta.url);

type Json = Record<string, unknown>;
interface Variant {
  properties: { kind: { const: string }; schema_version: Json; untrusted: { properties: Record<string, Json>; required: string[] } };
}

/** The committed schema as publishing it as this release would make it: schema_version "1.0", and the release's URL as $id. */
function published(version = "1.0", text = COMMITTED): Json {
  const schema = JSON.parse(text) as Json & { oneOf: Variant[] };
  schema["$id"] = `https://tiehall.com/schemas/packet/v${version}.json`;
  for (const variant of schema.oneOf) variant.properties.schema_version["const"] = "1.0";
  return schema;
}

/** A schema changed in each variant by this function. */
function changed(edit: (variant: Variant) => void, base: Json = published()): Json {
  const schema = structuredClone(base) as Json & { oneOf: Variant[] };
  for (const variant of schema.oneOf) edit(variant);
  return schema;
}

const text = (schema: Json) => `${JSON.stringify(schema, null, 2)}\n`;

/** The committed valid fixtures, as packets of v1.0. */
const FIXTURES: Record<string, string> = Object.fromEntries(
  readdirSync(VALID_FOLDER)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const packet = JSON.parse(readFileSync(new URL(name, VALID_FOLDER), "utf8")) as Json;
      return [`valid/${name}`, text({ ...packet, schema_version: "1.0" })];
    }),
);

const V1_0: PacketRelease = { version: "1.0", text: text(published()) };

/** The check's input: v1.0 published, the candidate unchanged, the fixtures of v1.0 as they ever were, changed as given. */
function input(change: Partial<ForwardInput> = {}): ForwardInput {
  return {
    releases: [V1_0],
    candidate: text(published()),
    candidateFixtures: FIXTURES,
    fixturesEver: Object.entries(FIXTURES).map(([name, fixture]) => ({ name, text: fixture, commit: "a".repeat(40) })),
    ...change,
  };
}

/** A v1.1 candidate that adds the field priority to the untrusted object of every packet, required or not. */
function withPriority(required: boolean): Json {
  return changed((variant) => {
    variant.properties.untrusted.properties["priority"] = { enum: ["low", "high"], type: "string", "x-tiehall-untrusted": true };
    if (required) variant.properties.untrusted.required.push("priority");
  });
}

describe("the packet's forward-compatibility check", () => {
  it("passes the real schema: a candidate that changes nothing against the simulated v1.0", () => {
    const result = checkPacketForward(input());
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails a v1.1 candidate that adds a required field: older packets, and every fixture that validated, fail it", () => {
    const result = checkPacketForward(input({ candidate: text(withPriority(true)) }));
    expect(result.passed).toBe(false);
    expect(result.problems).toContain("Against v1.0: adds the required field (kind: request) untrusted.priority.");
    expect(result.problems).toContain("Against v1.0: adds the required field (kind: contract_change) untrusted.priority.");
    expect(result.problems).toContain(
      `valid/minimal-request-packet.json as of ${"a".repeat(12)} validated against v1.0 and fails against the candidate.`,
    );
  });

  it("passes a candidate that adds an optional field, whose packets validate against v1.0", () => {
    const usesIt = text({ ...(JSON.parse(FIXTURES["valid/request-packet.json"] ?? "{}") as Json & { untrusted: Json }), kind: "request" });
    const packet = JSON.parse(usesIt) as Json & { untrusted: Json };
    packet.untrusted["priority"] = "high";
    const result = checkPacketForward(input({ candidate: text(withPriority(false)), candidateFixtures: { ...FIXTURES, "valid/priority.json": text(packet) } }));
    expect(result.problems).toEqual([]);
  });

  it("fails a candidate that removes a field, or makes a required one optional", () => {
    const removed = changed((variant) => delete variant.properties.untrusted.properties["links"]);
    expect(checkPacketForward(input({ candidate: text(removed) })).problems).toContain("Against v1.0: removes the field (kind: request) untrusted.links.");
    const optional = changed((variant) => (variant.properties.untrusted.required = variant.properties.untrusted.required.filter((name) => name !== "need")));
    expect(checkPacketForward(input({ candidate: text(optional) })).problems).toContain(
      "Against v1.0: makes the field (kind: request) untrusted.need optional, so a packet without it, built against the candidate, fails v1.0.",
    );
  });

  it("fails a candidate that narrows or widens a field's constraint, either of which breaks one direction", () => {
    const narrower = changed((variant) => (variant.properties.untrusted.properties["need"] = { ...variant.properties.untrusted.properties["need"], maxLength: 10_000 }));
    expect(checkPacketForward(input({ candidate: text(narrower) })).problems).toContain(
      "Against v1.0: changes maxLength of (kind: request) untrusted.need from 20000 to 10000.",
    );
    const wider = changed((variant) => {
      const contract = variant.properties.untrusted.properties["contract"] as { properties: { provider_status: { enum: string[] } } } | undefined;
      contract?.properties.provider_status.enum.push("draft");
    });
    expect(checkPacketForward(input({ candidate: text(wider) })).problems).toContain(
      'Against v1.0: changes enum of (kind: request) untrusted.contract.provider_status from ["open","merged","closed"] to ["open","merged","closed","draft"].',
    );
  });

  it("fails a candidate that adds a variant, whose packets older releases refuse, or changes schema_version", () => {
    const base = published() as Json & { oneOf: Variant[] };
    const incident = structuredClone(base.oneOf[0]) as Variant;
    incident.properties.kind.const = "incident";
    expect(checkPacketForward(input({ candidate: text({ ...base, oneOf: [...base.oneOf, incident] }) })).problems).toContain(
      "Against v1.0: adds the variant (kind: incident), whose packets v1.0 refuses.",
    );
    const renamed = changed((variant) => (variant.properties.schema_version["const"] = "1.1"));
    expect(checkPacketForward(input({ candidate: text(renamed) })).problems).toContain(
      'Against v1.0: changes const of (kind: request) schema_version from "1.0" to "1.1".',
    );
  });

  it("ignores annotations, such as a field's description, and the $id", () => {
    const described = changed((variant) => (variant.properties.untrusted.properties["need"] = { ...variant.properties.untrusted.properties["need"], description: "Something else." }));
    expect(schemaChanges(published(), { ...described, $id: "https://tiehall.com/schemas/packet/v1.1.json" })).toEqual([]);
  });

  it("checks the candidate against every published release, and every fixture version that validated against one of them", () => {
    const V1_1: PacketRelease = { version: "1.1", text: text(withPriority(false)) };
    const dropped = changed((variant) => delete variant.properties.untrusted.properties["priority"], withPriority(false));
    const result = checkPacketForward(input({ releases: [V1_0, V1_1], candidate: text(dropped) }));
    expect(result.problems).toEqual(["Against v1.1: removes the field (kind: request) untrusted.priority.", "Against v1.1: removes the field (kind: contract_change) untrusted.priority."]);
  });

  it("fails a fixture of the candidate that does not validate against an older release", () => {
    const loose = changed((variant) => (variant.properties.untrusted.properties["need"] = { ...variant.properties.untrusted.properties["need"], maxLength: 30_000 }));
    const long = JSON.parse(FIXTURES["valid/minimal-request-packet.json"] ?? "{}") as Json & { untrusted: Json };
    long.untrusted["need"] = "n".repeat(25_000);
    const result = checkPacketForward(input({ candidate: text(loose), candidateFixtures: { ...FIXTURES, "valid/long-need.json": text(long) } }));
    expect(result.problems).toContain(
      "valid/long-need.json, a valid fixture of the candidate, fails against v1.0: a packet built against the candidate must validate against every older release.",
    );
  });

  it("passes while no release is published, before which the notice rule of check:packet-compat applies", () => {
    expect(checkPacketForward(input({ releases: [] })).problems).toEqual([]);
  });
});

describe("pnpm check:packet-forward", () => {
  it("passes the repository, where no release is published yet", () => {
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No release of the packet schema is published yet");
  });
});
