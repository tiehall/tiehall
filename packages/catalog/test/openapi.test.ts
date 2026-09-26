import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand, SCOPES } from "../src/index.ts";
import { API_VERSION, openApiDocument, serializeDocument } from "../src/openapi.ts";

// The OpenAPI 3.1 document, generated from the catalog (public-api: What the
// document states for each operation; public-api: Responses can gain fields
// without breaking clients; public-api: Each operation carries a stability
// level; public-api: The API version number while the API is beta; design.md,
// Technical decisions: T10). Every operation offered on REST appears once,
// with its command id as operationId, its scopes under security, its
// stability level, its errors as RFC 9457 problems, the optional
// Idempotency-Key on POST and, where the CLI offers it, the CLI's command.

const packet = z.object({ need: z.string(), acceptance: z.array(z.string()) }).meta({ id: "Packet" });
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
