import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogProblems, CATALOG, defineCatalog, defineCommand, type CommandDefinition } from "../src/index.ts";
import {
  COMMITTED_TOOL_SNAPSHOT,
  lowerToolSchema,
  serializeToolSnapshot,
  ToolSchemaError,
  toolDescriptions,
  toolSnapshotDrift,
  toolSnapshotProblems,
} from "../src/tool-schemas.ts";

// Tool schemas that current clients accept (agent-surfaces: Tool schemas
// that current clients accept; public-api: MCP tools follow the same
// compatibility rules; design.md, Technical decisions: T9). MCP tool schemas
// are produced apart from the OpenAPI ones and lowered: every $ref inlined, a
// root of type object, no composition at the root, and variants as a `kind`
// enum plus optional fields, while execute() still validates with the zod
// union. The tools' names, descriptions and schemas are committed as a
// snapshot that CI regenerates and lints on every pull request.

const Person = z.object({ login: z.string().describe("The person's GitHub login.") }).meta({ id: "Person" });

/** A request's report, in two kinds: each variant is strict, so an input that mixes them is refused. */
const report = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("bug"),
      title: z.string().describe("A one-line summary."),
      steps: z.array(z.string()).describe("How to reproduce it."),
    }),
    z.strictObject({
      kind: z.literal("feature"),
      title: z.string().describe("A one-line summary."),
      goal: z.string().describe("What the feature is for."),
      owner: Person.optional(),
    }),
  ])
  .describe("What the report says.");

function tool(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return defineCommand({
    id: "reports.create",
    summary: "File a report on a request.",
    input: report,
    output: z.object({ reportId: z.string(), author: Person, reviewer: Person.optional() }),
    scopes: ["requests:write"],
    commitment: false,
    confirm: false,
    surfaces: ["mcp"],
    tool: "file_report",
    stability: "alpha",
    ...overrides,
  });
}

describe("lowering a tool schema", () => {
  it("lowers a union to an object with a kind enum and optional fields, saying which kind each field is for", () => {
    expect(lowerToolSchema(report, "input")).toEqual({
      type: "object",
      description: "What the report says.",
      properties: {
        kind: { type: "string", enum: ["bug", "feature"] },
        title: { type: "string", description: "A one-line summary." },
        steps: { type: "array", items: { type: "string" }, description: "How to reproduce it. Only when kind is bug, and required then." },
        goal: { type: "string", description: "What the feature is for. Only when kind is feature, and required then." },
        owner: {
          type: "object",
          properties: { login: { type: "string", description: "The person's GitHub login." } },
          required: ["login"],
          description: "Only when kind is feature.",
        },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    });
  });

  it("inlines every $ref, so a schema used twice appears in full twice and no $defs remain", () => {
    const lowered = lowerToolSchema(z.object({ author: Person, reviewer: Person }), "input");
    expect(JSON.stringify(lowered)).not.toMatch(/\$ref|\$defs|\$schema/);
    expect(lowered["properties"]).toEqual({
      author: { type: "object", properties: { login: { type: "string", description: "The person's GitHub login." } }, required: ["login"] },
      reviewer: { type: "object", properties: { login: { type: "string", description: "The person's GitHub login." } }, required: ["login"] },
    });
  });

  it("leaves additionalProperties: false out of outputs, which may gain fields", () => {
    expect(JSON.stringify(lowerToolSchema(z.object({ reportId: z.string(), author: Person }), "output"))).not.toContain("additionalProperties");
  });

  it("refuses what it cannot lower", () => {
    const refused: [string, z.ZodType, string][] = [
      ["a root that is not an object", z.string(), "a root of type object"],
      ["a plain union", z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), "a union on kind"],
      ["a union on another key", z.discriminatedUnion("type", [z.strictObject({ type: z.literal("a") }), z.strictObject({ type: z.literal("b") })]), "a union on kind"],
      [
        "variants that are not strict",
        z.discriminatedUnion("kind", [z.object({ kind: z.literal("a"), x: z.string() }), z.object({ kind: z.literal("b"), y: z.string() })]),
        "strict",
      ],
      ["a recursive schema", recursive(), "refers to itself"],
    ];
    for (const [what, schema, message] of refused) {
      expect(() => lowerToolSchema(schema, "input"), what).toThrow(ToolSchemaError);
      expect(() => lowerToolSchema(schema, "input"), what).toThrow(message);
    }
  });
});

describe("the catalog", () => {
  it("refuses a tool whose schemas cannot be lowered", () => {
    expect(catalogProblems([tool({ input: z.union([z.string(), z.number()]) })])).toEqual([
      expect.stringMatching(/^reports\.create: its tool's input schema cannot be lowered: /),
    ]);
    expect(catalogProblems([tool()])).toEqual([]);
  });
});

describe("the tool descriptions", () => {
  it("list each tool the catalog offers on MCP, by name, with its summary and lowered schemas", () => {
    const catalog = defineCatalog([tool(), tool({ id: "reports.list", tool: "list_reports", input: z.object({}), surfaces: ["mcp"] })]);
    const tools = toolDescriptions(catalog);
    expect(tools.map(({ name }) => name)).toEqual(["file_report", "list_reports"]);
    expect(tools[0]).toMatchObject({ name: "file_report", description: "File a report on a request.", inputSchema: { type: "object" } });
    expect(toolSnapshotProblems(tools)).toEqual([]);
  });

  it("are computed once per catalog", () => {
    const catalog = defineCatalog([tool()]);
    expect(toolDescriptions(catalog)).toBe(toolDescriptions(catalog));
  });
});

describe("the snapshot lint", () => {
  const good = { name: "file_report", description: "File a report.", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" } };

  it("fails a snapshot with a $ref, $defs or composition at the root, or a root that is not an object", () => {
    expect(
      toolSnapshotProblems([
        good,
        { ...good, name: "with_ref", inputSchema: { type: "object", properties: { author: { $ref: "#/$defs/Person" } } } },
        { ...good, name: "with_defs", outputSchema: { type: "object", $defs: { Person: { type: "object" } } } },
        { ...good, name: "root_one_of", inputSchema: { oneOf: [{ type: "object" }, { type: "object" }] } },
        { ...good, name: "root_all_of", inputSchema: { type: "object", allOf: [{ type: "object" }] } },
        { ...good, name: "root_string", outputSchema: { type: "string" } },
      ]),
    ).toEqual([
      "with_ref: its inputSchema has a $ref at properties.author.",
      "with_defs: its outputSchema has $defs.",
      "root_one_of: its inputSchema's root is not of type object.",
      "root_one_of: its inputSchema has oneOf at its root.",
      "root_all_of: its inputSchema has allOf at its root.",
      "root_string: its outputSchema's root is not of type object.",
    ]);
  });

  it("passes the committed snapshot, which is what the catalog generates", () => {
    const committed = readFileSync(COMMITTED_TOOL_SNAPSHOT, "utf8");
    expect(COMMITTED_TOOL_SNAPSHOT.endsWith("mcp/tools.json")).toBe(true);
    expect(toolSnapshotProblems((JSON.parse(committed) as { tools: never[] }).tools)).toEqual([]);
    expect(toolSnapshotDrift(CATALOG, committed)).toBeUndefined();
  });

  it("reports a tool change that was not regenerated, as a diff of the snapshot", () => {
    const catalog = defineCatalog([tool()]);
    const committed = serializeToolSnapshot(toolDescriptions(catalog));
    expect(toolSnapshotDrift(catalog, committed)).toBeUndefined();
    const changed = defineCatalog([tool({ summary: "File a bug or a feature report." })]);
    expect(toolSnapshotDrift(changed, committed)).toContain("pnpm mcp:generate");
    // A removed tool shows too.
    expect(toolSnapshotDrift(defineCatalog([]), committed)).toContain("file_report");
  });
});

function recursive(): z.ZodType {
  const node: z.ZodType = z.object({
    name: z.string(),
    get children() {
      return z.array(node);
    },
  });
  return node;
}
