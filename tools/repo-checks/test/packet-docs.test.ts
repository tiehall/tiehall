import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packetValidator, readPacketSchema } from "@tiehall/packet";
import { describe, expect, it } from "vitest";
import { fencedBlocks } from "../src/docs-commands.ts";
import { headings, linkProblems, links, section } from "../src/markdown.ts";

// The beta packet docs in the schema directory (task 28.7; handoff-packet: The
// Apache-2.0 schema directory; handoff-packet: The beta label;
// handoff-packet: Packet fields; handoff-packet: User-written fields are
// marked untrusted; handoff-packet: The `extensions` field).
// packages/packet/README.md explains each field of the schema, how
// user-written fields are marked untrusted, the rules for `extensions`, the
// beta label and the versioning rules. The check finds each section; every
// field the schema defines named in the field reference; every field the
// schema marks untrusted named in the section on the marking; the beta label
// as the schema states it; every JSON example validating against the schema;
// and every link resolving. It lives here, not in the Apache-2.0 directory,
// because it reads Markdown with the repository's own AGPL-3.0 tooling.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = "packages/packet/README.md";
const page = existsSync(join(root, PAGE)) ? readFileSync(join(root, PAGE), "utf8") : "";
const schema = readPacketSchema() as { $id: string; oneOf: JsonSchema[] };

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  const?: unknown;
  "x-tiehall-untrusted"?: boolean;
}

/** Every field the schema defines, by the name its object gives it, and the fields it marks untrusted. */
function fieldsOf(node: JsonSchema, names = new Set<string>(), untrusted = new Set<string>()): { names: Set<string>; untrusted: Set<string> } {
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    names.add(name);
    if (child["x-tiehall-untrusted"] === true) untrusted.add(name);
    fieldsOf(child, names, untrusted);
  }
  if (node.items !== undefined) fieldsOf(node.items, names, untrusted);
  return { names, untrusted };
}

const fields = schema.oneOf.map((variant) => fieldsOf(variant));
const names = new Set(fields.flatMap(({ names: each }) => [...each]));
const untrusted = new Set(fields.flatMap(({ untrusted: each }) => [...each]));

/** A section of the page, or the empty text when it has none. */
const part = (heading: string) => section(page, heading) ?? "";

const SECTIONS = ["The beta label", "Fields", "The untrusted marking", "`extensions`", "Versioning", "Conformance fixtures"];

describe("the packet docs", () => {
  it("have a section for each topic", () => {
    const level2 = headings(page)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(SECTIONS.filter((heading) => !level2.includes(heading))).toEqual([]);
  });

  it("explain every field the schema defines, each named as code in the field reference", () => {
    expect(names.size).toBeGreaterThan(20);
    const reference = part("Fields");
    expect([...names].filter((name) => !reference.includes(`\`${name}\``))).toEqual([]);
    for (const kind of schema.oneOf.map((variant) => variant.properties?.["kind"]?.const)) expect(reference).toContain(`\`${String(kind)}\``);
  });

  it("say what the schema itself refuses of a URL: an http or https URL, as a pattern a validator that skips formats keeps too", () => {
    const text = part("Fields").replace(/\s+/g, " ");
    expect(text).toContain("each with its `url`, an `http` or `https` URL");
    /** Every node of the schema with the uri format. */
    const uriNodes = (node: unknown): Record<string, unknown>[] => {
      if (Array.isArray(node)) return node.flatMap(uriNodes);
      if (typeof node !== "object" || node === null) return [];
      const own = (node as Record<string, unknown>)["format"] === "uri" ? [node as Record<string, unknown>] : [];
      return [...own, ...Object.values(node).flatMap(uriNodes)];
    };
    const urls = uriNodes(readPacketSchema());
    expect(urls.length).toBeGreaterThan(0);
    /**
     * Whether a schema's URL fields name no scheme: a validator of it accepts a `javascript:` URL in a link, as the
     * validator judges the patterns, however they are spelled, rather than as a reading of their text would.
     */
    const namesNoScheme = (of: unknown) =>
      packetValidator(of as Record<string, unknown>)({ schema_version: "1-beta", kind: "request", untrusted: { need: "A need.", links: [{ url: "javascript:alert(1)" }] } });
    // A schema whose URL fields name the scheme in a pattern of any spelling, such as one that matches either case.
    const withScheme = JSON.parse(JSON.stringify(readPacketSchema()), (_key, value: unknown) =>
      typeof value === "object" && value !== null && (value as Record<string, unknown>)["format"] === "uri" ? { ...value, pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" } : value,
    ) as Record<string, unknown>;
    expect(namesNoScheme(withScheme)).toBe(false);
    // The schema's URL fields name the scheme (decisions-from-groups-15-28, D55 (83)), so the page's caveat is gone.
    expect(namesNoScheme(readPacketSchema())).toBe(false);
    expect(text).not.toContain("does not refuse a URL of another scheme");
    expect(text).toContain("a pattern that admits only `http` and `https`");
    expect(text).toContain("refuses a URL of another scheme, such as a `javascript:` or `data:` URL");
  });

  it("say that a contract section attached by hand may leave out the provider pull request and its status", () => {
    const text = part("Fields").replace(/\s+/g, " ");
    expect(text).toContain("In a `request` packet, `provider_pr` and `provider_status` may be left out");
  });

  it("say how user-written fields are marked untrusted, naming each field the schema marks", () => {
    const text = part("The untrusted marking");
    expect(text).toContain("`x-tiehall-untrusted`");
    expect([...untrusted].filter((name) => !text.includes(`\`${name}\``))).toEqual([]);
  });

  it("state the rules for extensions: reverse-DNS namespaces, the size cap, kept as sent, refused otherwise", () => {
    const text = part("`extensions`").replace(/\s+/g, " ");
    for (const phrase of ["reverse-DNS namespace", "`com.acme.billing`", "255 characters", "16 KB", "kept exactly as sent", "400"]) expect(text, phrase).toContain(phrase);
  });

  it("state the beta label as the schema has it, and where each install serves it", () => {
    const text = part("The beta label").replace(/\s+/g, " ");
    expect(schema.$id).toBe("https://tiehall.com/schemas/packet/v1-beta.json");
    for (const phrase of [`\`${schema.$id}\``, '`"1-beta"`', "`/schemas/packet/v1-beta.json`", "without sign-in", '`"1.0"`', "beta"]) expect(text, phrase).toContain(phrase);
  });

  it("state the versioning rules before and after publication", () => {
    const text = part("Versioning").replace(/\s+/g, " ");
    for (const phrase of ["14 days", "`api-breaking`", "changelog", "only gains optional fields", "four weeks", "three companies"]) expect(text, phrase).toContain(phrase);
  });

  it("show only examples that validate against the schema", () => {
    const examples = fencedBlocks(page).filter(({ info }) => info === "json");
    expect(examples.length).toBeGreaterThan(1);
    const validate = packetValidator();
    for (const { text, line } of examples) expect(validate(JSON.parse(text)), `the example on line ${line}`).toBe(true);
  });

  it("point to the schema, the fixtures and the license, with links that all resolve", () => {
    const targets = links(page).map(({ target }) => target);
    for (const target of ["schema/v1-beta.json", "fixtures/valid", "fixtures/invalid", "LICENSE"]) expect(targets, target).toContain(target);
    expect(linkProblems(root, PAGE)).toEqual([]);
  });
});
