import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiMajorOf, apiMajorsOf, CATALOG, catalogProblems, defineCatalog, defineCommand, OPENAPI_DOCUMENTS, type CommandDefinition, type EarlierShape } from "../src/index.ts";
import { openApiDocument, serializeDocument } from "../src/openapi.ts";

// Two API versions from one definition (public-api: After graduation,
// breaking changes go to a new major version; public-api: The major version is
// in the path; public-api: MCP tools follow the same compatibility rules;
// design.md, Where the specs leave room: Two API versions). Once an operation
// is stable it only gains fields and options; a breaking change to it is made
// under /api/v2, and /api/v1 keeps serving the old operation for at least
// six months. One catalog definition serves both: it describes the
// operation's current shape at its /api/v2 path, and keeps its earlier shape
// for /api/v1, with the two functions that carry a v1 call's input to the
// current shape and the current output back to v1. Each major version has a
// document of its own, generated from the definitions it serves; a v1
// document is the same, byte for byte, after the operation gains its v2
// shape as before.

/** A synthetic stable operation, as it is before any breaking change: it reads a widget's name. */
const widgetV1 = defineCommand({
  id: "widgets.get",
  summary: "Read a widget.",
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), name: z.string() }),
  method: "GET",
  path: "/api/v1/widgets/{id}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "cli"],
  cli: [{ command: "widget", arguments: ["id"] }],
  stability: "stable",
});

/** The same operation after a breaking change: its name is now its title, and a read names the locale it is in. */
const widgetV2 = defineCommand({
  ...widgetV1,
  input: z.object({ id: z.string(), locale: z.enum(["en", "tr"]) }),
  output: z.object({ id: z.string(), title: z.string(), locale: z.enum(["en", "tr"]) }),
  path: "/api/v2/widgets/{id}",
  cli: [{ command: "widget", arguments: ["id"], defaults: { locale: "en" } }],
  earlier: [
    {
      major: 1,
      method: "GET",
      path: "/api/v1/widgets/{id}",
      input: widgetV1.input,
      output: widgetV1.output,
      cli: [{ command: "widget", arguments: ["id"] }],
      stability: "stable",
      toCurrent: (input: { id: string }) => ({ ...input, locale: "en" }),
      fromCurrent: ({ id, title }: { id: string; title: string }) => ({ id, name: title }),
    },
  ],
});

/** Another operation that stays in v1 alone. */
const gadget = defineCommand({
  id: "gadgets.list",
  summary: "List gadgets.",
  input: z.object({}),
  output: z.object({ gadgets: z.array(z.string()) }),
  method: "GET",
  path: "/api/v1/gadgets",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
});

describe("a stable operation that gains a breaking shape under /api/v2", () => {
  it("is one definition, registered with its earlier shape for /api/v1", () => {
    const catalog = defineCatalog([widgetV2, gadget]);
    expect(catalog.get("widgets.get")).toBe(widgetV2);
    expect(apiMajorOf(widgetV2)).toBe(2);
    expect(apiMajorOf(gadget)).toBe(1);
  });

  it("leaves the /api/v1 document as it was, byte for byte", () => {
    const before = serializeDocument(openApiDocument(defineCatalog([widgetV1, gadget])));

    const after = serializeDocument(openApiDocument(defineCatalog([widgetV2, gadget]), { major: 1 }));

    expect(after).toBe(before);
  });

  it("is listed in the /api/v2 document with its breaking shape, and nothing that stays in v1 is", () => {
    const document = openApiDocument(defineCatalog([widgetV2, gadget]), { major: 2 }) as {
      info: { description: string };
      paths: Record<string, Record<string, Record<string, any>>>;
    };

    expect(Object.keys(document.paths)).toEqual(["/api/v2/widgets/{id}"]);
    const operation = document.paths["/api/v2/widgets/{id}"]?.["get"];
    expect(operation?.["operationId"]).toBe("widgets.get");
    expect(operation?.["x-stability-level"]).toBe("stable");
    expect(operation?.["responses"]["200"].content["application/json"].schema.required).toEqual(["id", "title", "locale"]);
    expect(operation?.["parameters"].map(({ name }: { name: string }) => name)).toEqual(["id", "locale"]);
    expect(operation?.["x-tiehall-cli"]).toEqual({ commands: [{ command: "widget", arguments: ["id"], defaults: { locale: "en" } }] });
    expect(document.info.description).toContain("under /api/v2");
  });
});

describe("an earlier shape", () => {
  const shape = widgetV2.earlier![0]!;
  /** The catalog with the operation's earlier shape, and the operation itself, changed; a field given as undefined is left out. */
  const withShape = (changes: Record<string, unknown>, definition: Record<string, unknown> = {}): CommandDefinition[] => [
    { ...widgetV2, ...definition, earlier: [{ ...shape, ...changes } as EarlierShape] } as CommandDefinition,
    gadget,
  ];

  it("is refused for an operation not offered on REST", () => {
    expect(catalogProblems(withShape({}, { surfaces: [], cli: undefined }))).toContain(
      "widgets.get: it has an earlier shape, which only an operation offered on REST has.",
    );
  });

  it("is refused under a major version that is not below the operation's own, or twice under one", () => {
    expect(catalogProblems(withShape({ major: 2, path: "/api/v2/old-widgets/{id}" }))).toEqual([
      "widgets.get: its earlier shape for /api/v2 is not under an earlier major version than its own, /api/v2.",
    ]);
    expect(catalogProblems([{ ...widgetV2, path: "/api/v3/widgets/{id}", earlier: [shape, { ...shape, path: "/api/v1/widgets-again/{id}" }] }])).toEqual([
      "widgets.get: it has two earlier shapes for /api/v1.",
    ]);
  });

  it("is refused at a path outside its major version, or the path of another operation", () => {
    expect(catalogProblems(withShape({ path: "/api/v2/old/{id}" }))).toEqual([
      "widgets.get: the path /api/v2/old/{id} of its earlier shape for /api/v1 does not start with /api/v1/.",
    ]);
    expect(catalogProblems(withShape({ path: "/api/v1/gadgets", input: z.object({}), cli: undefined }))).toEqual([
      "widgets.get: GET /api/v1/gadgets, the path of its earlier shape for /api/v1, is also the path of gadgets.list.",
    ]);
  });

  it("is refused when its path names a field its input lacks, or its CLI command one", () => {
    expect(catalogProblems(withShape({ input: z.object({ key: z.string() }), cli: [{ command: "widget", arguments: ["key"] }] }))).toEqual([
      "widgets.get: the path /api/v1/widgets/{id} of its earlier shape names {id}, which is not a field of its input.",
    ]);
    expect(catalogProblems(withShape({ cli: [{ command: "widget", arguments: ["name"] }] }))).toEqual([
      "widgets.get: its earlier shape's CLI command widget takes name as an argument, which is not a field of its input.",
    ]);
  });

  it("is refused for an operation with If-Match or an ETag, whose versions wait for one that needs them", () => {
    expect(catalogProblems(withShape({}, { etag: "id" }))).toEqual([
      "widgets.get: it has an earlier shape and names If-Match or an ETag, which earlier shapes do not carry yet.",
    ]);
  });
});

describe("an operation's path", () => {
  it("starts with the API's major version, such as /api/v1/ or /api/v2/", () => {
    expect(catalogProblems([{ ...gadget, path: "/api/gadgets" }])).toEqual([
      "gadgets.list: its path /api/gadgets does not start with /api/v<N>/, where the API's major version N lives.",
    ]);
    expect(catalogProblems([{ ...gadget, path: "/api/v2/gadgets" }])).toEqual([]);
  });
});

describe("the real catalog", () => {
  it("serves the document of every major version its operations are served under, so a later one is wired once it exists", () => {
    expect(apiMajorsOf(defineCatalog([widgetV2, gadget]))).toEqual([1, 2]);
    for (const major of apiMajorsOf(CATALOG)) expect(Object.keys(OPENAPI_DOCUMENTS), `/api/v${major}`).toContain(String(major));
    expect(apiMajorsOf(CATALOG)).toEqual([1]);
  });
});
