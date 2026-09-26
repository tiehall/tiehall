import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand, packet, SCOPES } from "../src/index.ts";
import { API_VERSION, openApiDocument, serializeDocument } from "../src/openapi.ts";

// The OpenAPI 3.1 document, generated from the catalog (public-api: What the
// document states for each operation; public-api: Responses can gain fields
// without breaking clients; public-api: Each operation carries a stability
// level; public-api: The API version number while the API is beta; design.md,
// Technical decisions: T10). Every operation offered on REST appears once,
// with its command id as operationId, its scopes under security, its
// stability level, its errors as RFC 9457 problems, the optional
// Idempotency-Key on POST and, where the CLI offers it, the CLI's command.

const request = z.object({ key: z.string(), title: z.string(), packet });

const catalog = defineCatalog([
  defineCommand({
    id: "requests.create",
    summary: "Open a request to a team.",
    input: z.object({ team: z.string(), title: z.string(), packet }),
    output: request,
    method: "POST",
    path: "/api/v1/requests",
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp", "cli"],
    tool: "open_request",
    cliCommand: "open",
    stability: "beta",
  }),
  defineCommand({
    id: "requests.get",
    summary: "Read a request.",
    input: z.object({ key: z.string(), page: z.coerce.number().int().optional() }),
    output: request,
    method: "GET",
    path: "/api/v1/requests/{key}",
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "mcp"],
    tool: "get_request",
    stability: "beta",
    deprecated: { since: "2026-10-01", sunset: "2026-12-15" },
  }),
  defineCommand({
    id: "requests.decline",
    summary: "Propose to decline a request.",
    input: z.object({ key: z.string(), reason: z.string() }),
    output: z.object({ proposalId: z.string(), confirmations: z.array(z.string()) }),
    method: "POST",
    path: "/api/v1/requests/{key}/decline",
    scopes: ["requests:write"],
    commitment: true,
    confirm: false,
    surfaces: ["rest", "cli"],
    cliCommand: "decline",
    stability: "alpha",
  }),
  defineCommand({
    id: "contract.report",
    summary: "Report the classified changes of a provider pull request.",
    input: z.object({ api: z.string() }),
    output: z.object({ changeSetId: z.string() }),
    method: "POST",
    path: "/api/v1/contract/reports",
    scopes: ["contracts:report"],
    commitment: false,
    confirm: false,
    surfaces: ["rest", "cli"],
    cliCommand: "contract report",
    stability: "stable",
  }),
  defineCommand({
    id: "requests.whats_new",
    summary: "An MCP tool with no REST operation.",
    input: z.object({}),
    output: z.object({}),
    scopes: ["requests:read"],
    commitment: false,
    confirm: false,
    surfaces: ["mcp"],
    tool: "whats_new",
    stability: "beta",
  }),
  defineCommand({
    id: "members.change_role",
    summary: "An internal command, with the confirmation step.",
    input: z.object({ userId: z.string() }),
    output: z.object({}),
    scopes: [],
    commitment: false,
    confirm: true,
    surfaces: [],
    stability: "beta",
  }),
]);

type Json = Record<string, unknown>;
const document = openApiDocument(catalog, { version: "0.4.0" }) as Json & { paths: Record<string, Record<string, Json>> };
const operation = (path: string, method: string) => document.paths[path]?.[method] as Json & { parameters?: Json[]; responses: Record<string, Json> };

/** Every value under a key anywhere in a JSON value. */
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([name, item]) => [...(name === key ? [item] : []), ...valuesOf(item, key)]);
}

/** Resolves a local $ref of the document. */
function resolved(schema: Json): Json {
  const ref = schema["$ref"];
  if (typeof ref !== "string") return schema;
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((node, part) => (node as Json)[part], document) as Json;
}

describe("the OpenAPI document", () => {
  it("is OpenAPI 3.1.0 with info.version of the form 0.N.0", () => {
    expect(document["openapi"]).toBe("3.1.0");
    expect(document["info"]).toMatchObject({ version: "0.4.0", title: expect.any(String) });
    expect(openApiDocument(catalog)["info"]).toMatchObject({ version: API_VERSION });
    expect(API_VERSION).toMatch(/^0\.(0|[1-9]\d*)\.0$/);
    for (const version of ["1.0.0", "0.4.1", "0.04.0", "v0.4.0"]) {
      expect(() => openApiDocument(catalog, { version }), version).toThrow("0.N.0");
    }
  });

  it("lists every operation offered on REST, and nothing else", () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/contract/reports",
      "/api/v1/requests",
      "/api/v1/requests/{key}",
      "/api/v1/requests/{key}/decline",
    ]);
    expect(valuesOf(document.paths, "operationId").sort()).toEqual(["contract.report", "requests.create", "requests.decline", "requests.get"]);
    expect(JSON.stringify(document)).not.toMatch(/whats_new|change_role/);
  });

  it("gives each operation its command id, its scopes under security and its stability level", () => {
    expect(operation("/api/v1/requests", "post")).toMatchObject({
      operationId: "requests.create",
      summary: "Open a request to a team.",
      security: [{ bearer: ["requests:write"] }],
      "x-stability-level": "beta",
    });
    expect(operation("/api/v1/contract/reports", "post")).toMatchObject({ security: [{ bearer: ["contracts:report"] }], "x-stability-level": "stable" });
    expect(operation("/api/v1/requests/{key}/decline", "post")["x-stability-level"]).toBe("alpha");
    const scopes = valuesOf(document, "security").flatMap((requirements) =>
      (requirements as Record<string, string[]>[]).flatMap((requirement) => Object.values(requirement).flat()),
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(SCOPES).toContain(scope);
    expect(document["components"]).toMatchObject({ securitySchemes: { bearer: { type: "http", scheme: "bearer" } } });
  });

  it("builds the parameters from the path and the query, and the body from the rest of the input", () => {
    expect(operation("/api/v1/requests/{key}", "get").parameters).toEqual([
      expect.objectContaining({ in: "path", name: "key", required: true }),
      expect.objectContaining({ in: "query", name: "page" }),
    ]);
    const create = operation("/api/v1/requests", "post");
    const body = resolved((create["requestBody"] as { content: Record<string, { schema: Json }> }).content["application/json"]?.schema ?? {});
    expect(Object.keys(body["properties"] as Json).sort()).toEqual(["packet", "team", "title"]);
    const decline = operation("/api/v1/requests/{key}/decline", "post");
    const declineBody = (decline["requestBody"] as { content: Record<string, { schema: Json }> }).content["application/json"]?.schema ?? {};
    expect(Object.keys(declineBody["properties"] as Json)).toEqual(["reason"]);
  });

  // agent-surfaces: Tool schemas that current clients accept. The document keeps the variants, which REST
  // takes as they are; only the MCP tool schema lowers them to a kind enum.
  it("gives an input with variants its path parameters and a body with one schema per variant", () => {
    const withVariants = openApiDocument(
      defineCatalog([
        defineCommand({
          id: "requests.post_message",
          summary: "Post a comment or an answer on a request.",
          input: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("comment"), key: z.string(), body: z.string() }),
            z.strictObject({ kind: z.literal("answer"), key: z.string(), body: z.string(), questionId: z.string() }),
          ]),
          output: z.object({ messageId: z.string() }),
          method: "POST",
          path: "/api/v1/requests/{key}/messages",
          scopes: ["requests:write"],
          commitment: false,
          confirm: false,
          surfaces: ["rest", "mcp"],
          tool: "post_message",
          stability: "alpha",
        }),
      ]),
    ) as Json & { paths: Record<string, Record<string, Json & { parameters?: Json[] }>> };
    const post = withVariants.paths["/api/v1/requests/{key}/messages"]?.["post"] ?? {};
    expect(post.parameters?.filter(({ in: where }) => where !== "header")).toEqual([
      expect.objectContaining({ in: "path", name: "key", required: true }),
    ]);
    const body = (post["requestBody"] as { content: Record<string, { schema: Json }> }).content["application/json"]?.schema ?? {};
    const variants = (body["oneOf"] ?? body["anyOf"]) as Json[];
    expect(variants.map((variant) => Object.keys(variant["properties"] as Json).sort())).toEqual([
      ["body", "kind"],
      ["body", "kind", "questionId"],
    ]);
    expect(variants.map((variant) => (variant["properties"] as Record<string, Json>)["kind"])).toEqual([
      expect.objectContaining({ const: "comment" }),
      expect.objectContaining({ const: "answer" }),
    ]);
  });

  it("offers the optional Idempotency-Key header on every POST, and on no other method", () => {
    for (const path of ["/api/v1/requests", "/api/v1/requests/{key}/decline", "/api/v1/contract/reports"]) {
      const header = operation(path, "post").parameters?.find(({ in: where }) => where === "header");
      expect(header, path).toMatchObject({ name: "Idempotency-Key", schema: { type: "string" } });
      expect(header?.["required"], path).not.toBe(true);
    }
    expect(operation("/api/v1/requests/{key}", "get").parameters?.some(({ name }) => name === "Idempotency-Key")).toBe(false);
  });

  it("names the CLI's command in x-tiehall-cli on each operation the CLI offers", () => {
    expect(operation("/api/v1/requests", "post")["x-tiehall-cli"]).toEqual({ command: "open" });
    expect(operation("/api/v1/contract/reports", "post")["x-tiehall-cli"]).toEqual({ command: "contract report" });
    expect(operation("/api/v1/requests/{key}/decline", "post")["x-tiehall-cli"]).toEqual({ command: "decline" });
    expect(operation("/api/v1/requests/{key}", "get")).not.toHaveProperty("x-tiehall-cli");
  });

  it("marks a deprecated operation with its sunset date", () => {
    expect(operation("/api/v1/requests/{key}", "get")).toMatchObject({ deprecated: true, "x-sunset": "2026-12-15" });
    expect(operation("/api/v1/requests", "post")).not.toHaveProperty("deprecated");
    expect(operation("/api/v1/requests", "post")).not.toHaveProperty("x-sunset");
  });

  it("answers 200 with the output, and 202 for a commitment", () => {
    expect(Object.keys(operation("/api/v1/requests", "post").responses)).toContain("200");
    const decline = operation("/api/v1/requests/{key}/decline", "post").responses;
    expect(Object.keys(decline)).toContain("202");
    expect(Object.keys(decline)).not.toContain("200");
  });

  it("describes errors as RFC 9457 problems", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, described] of Object.entries(methods)) {
        const errors = Object.entries((described as { responses: Record<string, Json> }).responses).filter(([status]) => Number(status) >= 400);
        expect(errors.map(([status]) => status), `${method} ${path}`).toEqual(expect.arrayContaining(["400", "401", "403", "404", "429", "503"]));
        for (const [, response] of errors) {
          const content = response["content"] as Record<string, { schema: Json }>;
          expect(Object.keys(content)).toEqual(["application/problem+json"]);
          expect(resolved(content["application/problem+json"]?.schema ?? {})).toMatchObject({
            type: "object",
            required: expect.arrayContaining(["type", "title", "status", "detail"]),
          });
        }
      }
    }
    expect(Object.keys(operation("/api/v1/requests", "post").responses)).toEqual(expect.arrayContaining(["409", "422"]));
    expect(operation("/api/v1/requests", "post").responses["429"]).toMatchObject({ headers: { "Retry-After": expect.any(Object) } });
  });

  it("never forbids additional properties in a response, so a new field breaks no generated client", () => {
    const responses = Object.values(document.paths).flatMap((methods) => Object.values(methods).map((described) => described["responses"]));
    const reachable = JSON.stringify([responses, (document["components"] as Json)["schemas"]]);
    expect(reachable).not.toContain('"additionalProperties":false');
  });

  it("keeps one component id for a schema used in both requests and responses", () => {
    const schemas = (document["components"] as { schemas: Json }).schemas;
    expect(Object.keys(schemas).filter((id) => id.startsWith("Packet"))).toEqual(["Packet"]);
    const refs = valuesOf(document.paths, "$ref").filter((ref) => String(ref).includes("Packet"));
    expect(new Set(refs)).toEqual(new Set(["#/components/schemas/Packet"]));
    expect(refs.length).toBeGreaterThanOrEqual(3);
  });
});

// public-api: Packet revisions use ETag and If-Match; public-api: What the
// document states for each operation. The operation that adds a packet
// revision lists If-Match as a required header, which REST turns into the
// revision the caller expects, and answers 412 and 428; a packet read states
// the ETag of what it returns.
describe("ETag and If-Match in the document", () => {
  const packetDocument = openApiDocument(
    defineCatalog([
      defineCommand({
        id: "packets.get",
        summary: "Read a request's packet.",
        input: z.object({ key: z.string() }),
        output: z.object({ revision: z.number().int(), packet }),
        method: "GET",
        path: "/api/v1/requests/{key}/packet",
        scopes: ["requests:read"],
        commitment: false,
        confirm: false,
        surfaces: ["rest"],
        stability: "alpha",
        etag: "revision",
      }),
      defineCommand({
        id: "packets.add_revision",
        summary: "Add a revision of a request's packet.",
        input: z.object({ key: z.string(), expectedRevision: z.number().int().min(1).optional(), packet }),
        output: z.object({ revision: z.number().int(), packet }),
        method: "POST",
        path: "/api/v1/requests/{key}/packet/revisions",
        scopes: ["requests:write"],
        commitment: false,
        confirm: false,
        surfaces: ["rest"],
        stability: "alpha",
        ifMatch: "expectedRevision",
        etag: "revision",
      }),
    ]),
  ) as Json & { paths: Record<string, Record<string, Json & { parameters?: Json[]; responses: Record<string, Json> }>> };
  const add = packetDocument.paths["/api/v1/requests/{key}/packet/revisions"]?.["post"];
  const read = packetDocument.paths["/api/v1/requests/{key}/packet"]?.["get"];

  it("lists If-Match as a required header of the operation that adds a revision, and not in its body", () => {
    const ifMatch = add?.parameters?.find(({ name }) => name === "If-Match");
    expect(ifMatch).toMatchObject({ in: "header", required: true, schema: { type: "string" } });
    const body = (add?.["requestBody"] as { content: Record<string, { schema: Json }> }).content["application/json"]?.schema ?? {};
    expect(Object.keys(body["properties"] as Json)).toEqual(["packet"]);
    expect(read?.parameters?.some(({ name }) => name === "If-Match")).toBe(false);
  });

  it("answers 428 without If-Match and 412 when it does not match", () => {
    expect(add?.responses["428"]).toMatchObject({ content: { "application/problem+json": expect.any(Object) } });
    expect(add?.responses["412"]).toMatchObject({ content: { "application/problem+json": expect.any(Object) } });
    expect(Object.keys(read?.responses ?? {})).not.toContain("428");
  });

  it("states the ETag of a packet read and of the revision added", () => {
    for (const operation of [read, add]) {
      expect(operation?.responses["200"]).toMatchObject({ headers: { ETag: { schema: { type: "string" } } } });
    }
  });

  it("uses one packet component for adding a revision and reading a packet", () => {
    expect(Object.keys((packetDocument["components"] as { schemas: Json }).schemas).filter((id) => id.startsWith("Packet"))).toEqual(["Packet"]);
    expect(new Set(valuesOf([add, read], "$ref").filter((ref) => String(ref).includes("Packet")))).toEqual(new Set(["#/components/schemas/Packet"]));
  });
});

describe("the committed form", () => {
  it("sorts every object's keys and ends with a newline, so a change shows as a small diff", () => {
    const text = serializeDocument(document);
    expect(text.endsWith("}\n")).toBe(true);
    const keysInOrder = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(keysInOrder);
      if (typeof value !== "object" || value === null) return;
      const keys = Object.keys(value);
      expect(keys).toEqual([...keys].sort());
      Object.values(value).forEach(keysInOrder);
    };
    keysInOrder(JSON.parse(text));
    expect(JSON.parse(text)).toEqual(document);
    expect(serializeDocument(openApiDocument(catalog, { version: "0.4.0" }))).toBe(text);
  });
});
