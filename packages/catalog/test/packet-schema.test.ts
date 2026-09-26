import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG, packet, PACKET_SCHEMA_ID } from "../src/index.ts";
import { openApiDocument, serializeDocument } from "../src/openapi.ts";
import { packetJsonSchema, packetSchemaDrift, packetSchemaProblems } from "../src/packet-schema.ts";

// One definition for the schema and the API (handoff-packet: One definition
// for the schema and the API; handoff-packet: The packet format; design.md,
// Technical decisions: T11). The JSON Schema file in the Apache-2.0 schema
// directory and the OpenAPI document's packet component are both generated
// from the catalog's packet definition. The CI check fails when the two
// differ, when an object of the schema forbids additional properties, or when
// the operations that take and return packets use more than one packet
// component, such as Packet for adding a revision and PacketOutput for
// reading one.

type Json = Record<string, unknown>;

function fixture(name: string, file: "schema.json" | "openapi.json"): Json {
  return JSON.parse(readFileSync(new URL(`./fixtures/packet-schema/${name}/${file}`, import.meta.url), "utf8")) as Json;
}

function problemsOf(name: string): string[] {
  return packetSchemaProblems(fixture(name, "schema.json"), fixture(name, "openapi.json"));
}

/** Every object node of a JSON value, with its path. */
function* nodes(value: unknown, path = ""): Generator<[string, Json]> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* nodes(item, `${path}/${index}`);
  } else if (typeof value === "object" && value !== null) {
    yield [path, value as Json];
    for (const [key, item] of Object.entries(value)) yield* nodes(item, `${path}/${key}`);
  }
}

describe("the packet JSON Schema", () => {
  const schema = packetJsonSchema();

  it("is JSON Schema 2020-12 with the beta $id, whose root is an object", () => {
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://tiehall.com/schemas/packet/v1-beta.json",
      type: "object",
    });
    expect(PACKET_SCHEMA_ID).toBe(schema["$id"]);
    expect(schema["$id"]).not.toMatch(/v1\.\d+\.json$|\/v1\.json$/);
  });

  it("has no object that forbids additional properties, and no reference to another document", () => {
    for (const [path, node] of nodes(schema)) {
      expect(node["additionalProperties"], path).not.toBe(false);
      expect(node["unevaluatedProperties"], path).not.toBe(false);
      if (typeof node["$ref"] === "string") expect(node["$ref"], path).toMatch(/^#/);
    }
  });

  it("is the packet definition's input schema, with a variant for each kind", () => {
    const variants = schema["oneOf"] as Json[];
    expect(variants.map((variant) => ((variant["properties"] as Record<string, Json>)["kind"] as Json)["const"])).toEqual(["request", "contract_change"]);
    expect(packet.safeParse({ schema_version: "1-beta", kind: "request", untrusted: { need: "Something." } }).success).toBe(true);
  });
});

describe("the OpenAPI packet component", () => {
  const document = openApiDocument(CATALOG) as Json & { components: { schemas: Record<string, Json> } };

  it("is in the document once, as Packet", () => {
    expect(Object.keys(document.components.schemas).filter((name) => name.startsWith("Packet"))).toEqual(["Packet"]);
  });

  it("defines the same fields with the same types as the JSON Schema file", () => {
    const { $schema: _schema, $id: _id, ...fields } = packetJsonSchema();
    expect(document.components.schemas["Packet"]).toEqual(fields);
    expect(packetSchemaProblems(packetJsonSchema(), document)).toEqual([]);
  });
});

describe("the CI check", () => {
  it("passes a schema and a document that agree and use one packet component", () => {
    expect(problemsOf("matching")).toEqual([]);
  });

  it("fails where the schema file and the OpenAPI component differ", () => {
    expect(problemsOf("differs")).toEqual([
      'The JSON Schema file and the OpenAPI component Packet differ at /properties/untrusted/properties/need/type: the file has "string", the component "integer".',
    ]);
  });

  it("fails where an object forbids additional properties", () => {
    expect(problemsOf("closed-object")).toEqual([
      "The JSON Schema file forbids additional properties at /properties/untrusted/properties/links/items; packet objects stay open.",
    ]);
  });

  it("fails where the revision-add and packet-read operations use different components", () => {
    expect(problemsOf("split-components")).toEqual([
      "The OpenAPI document has a second packet component, PacketOutput; requests and responses use the one component Packet.",
      "packets.get uses the packet component PacketOutput, while packets.add_revision uses Packet; every operation uses the one component Packet.",
    ]);
  });

  it("fails a document without the packet component", () => {
    const document = fixture("matching", "openapi.json") as Json & { components: { schemas: Json } };
    document.components.schemas = {};
    expect(packetSchemaProblems(fixture("matching", "schema.json"), document)).toEqual([
      "The OpenAPI document has no packet component Packet.",
    ]);
  });

  it("fails a committed schema file that is not the one the definition generates", () => {
    const generated = serializeDocument(packetJsonSchema());
    expect(packetSchemaDrift(generated)).toBeUndefined();
    const edited = generated.replace('"minLength": 1', '"minLength": 2');
    expect(packetSchemaDrift(edited)).toMatch(/^packages\/packet\/schema\/v1-beta\.json differs from the schema the packet definition generates\./);
  });
});
