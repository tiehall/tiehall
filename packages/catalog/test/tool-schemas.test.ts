import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogProblems, CATALOG, defineCatalog, defineCommand, type CommandDefinition } from "../src/index.ts";
import { committedToolSnapshotPath } from "../src/committed-files.ts";
import { proposalAnswer } from "../src/proposals.ts";
import {
  dropUnknownVariantKeys,
  lowerToolSchema,
  serializeToolSnapshot,
  STABILITY_META_KEY,
  ToolSchemaError,
  toolDescriptions,
  toolListing,
  toolReadsOnly,
  toolSnapshot,
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
// snapshot that CI regenerates and lints on every pull request, with each
// tool's stability level and deprecation, which the compatibility check reads
// (public-api: MCP tools follow the same compatibility rules).

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

// An input with variants (agent-surfaces: Tool schemas that current clients accept; requests: Provenance is
// stamped by the server). Its variants are strict, so a field of another variant is refused; a key that no
// variant has is dropped before the input is parsed, as for any other input, such as provenance a payload claims.
describe("an input with variants", () => {
  it("loses the keys no variant has, and keeps a key of another variant, which parsing then refuses", () => {
    const input = { kind: "bug", title: "It breaks", steps: ["Open it"], goal: "Faster", surface: "web", actorKind: "human" };
    const dropped = dropUnknownVariantKeys(report, input);
    expect(dropped).toEqual({ kind: "bug", title: "It breaks", steps: ["Open it"], goal: "Faster" });
    expect(report.safeParse(dropped).success).toBe(false);
    expect(report.safeParse(dropUnknownVariantKeys(report, { kind: "bug", title: "It breaks", steps: ["Open it"], surface: "web" })).success).toBe(true);
  });

  it("leaves an input that is not an object, and an input without variants, as it is", () => {
    const plain = z.strictObject({ title: z.string() });
    const input = { title: "It breaks", surface: "web" };
    expect(dropUnknownVariantKeys(plain, input)).toBe(input);
    expect(dropUnknownVariantKeys(report, "bug")).toBe("bug");
    expect(dropUnknownVariantKeys(report, ["bug"])).toEqual(["bug"]);
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

  // agent-surfaces: Commitment tools return proposals. A commitment's call that makes one answers with
  // { proposal } instead of the operation's own output, so the listed output schema admits both, with no
  // composition at its root: an object with the output's fields and the proposal's, none of them required.
  it("list a commitment tool's output as one object that admits the operation's output or, instead, only the proposal it created", () => {
    const own = z.object({ reportId: z.string(), author: Person });
    const [listed] = toolDescriptions(defineCatalog([tool({ commitment: true, output: own })]));
    const ownLowered = lowerToolSchema(own, "output");
    const proposalLowered = lowerToolSchema(proposalAnswer, "output");
    expect(listed?.outputSchema).toEqual({
      type: "object",
      description: expect.stringContaining("only proposal"),
      properties: {
        ...(ownLowered["properties"] as object),
        proposal: (proposalLowered["properties"] as Record<string, unknown>)["proposal"],
      },
    });
    expect(toolSnapshotProblems(listed === undefined ? [] : [listed])).toEqual([]);
    // A tool that is no commitment lists its output as it is.
    expect(toolDescriptions(defineCatalog([tool({ output: own })]))[0]?.outputSchema).toEqual(ownLowered);
  });

  it("are computed once per catalog", () => {
    const catalog = defineCatalog([tool()]);
    expect(toolDescriptions(catalog)).toBe(toolDescriptions(catalog));
  });
});

// Tool annotations and stability levels (agent-surfaces: Tool annotations and
// stability levels; design.md, Decisions this change rests on: D28 #65). Every
// tool carries MCP annotations, whose read-only hint is true only for a tool
// that only reads: one whose operation needs no scope but requests:read, and
// is offered on REST, if at all, with GET. Every tool's _meta states its
// operation's stability level.
describe("the tool listing", () => {
  const read = (overrides: Partial<CommandDefinition> = {}) =>
    tool({ id: "reports.get", tool: "get_report", input: z.object({ id: z.string() }), scopes: ["requests:read"], ...overrides });

  it("hints read-only only for a tool whose operation needs no scope but requests:read and is offered with GET, if on REST", () => {
    expect(toolReadsOnly(read())).toBe(true);
    expect(toolReadsOnly(read({ surfaces: ["rest", "mcp"], method: "GET", path: "/api/v1/reports/{id}" }))).toBe(true);
    expect(toolReadsOnly(tool())).toBe(false);
    expect(toolReadsOnly(read({ scopes: ["requests:read", "requests:write"] }))).toBe(false);
    expect(toolReadsOnly(read({ scopes: ["contracts:report"] }))).toBe(false);
    // An operation that needs only requests:read but is sent with POST changes something, such as acknowledging events.
    expect(toolReadsOnly(read({ surfaces: ["rest", "mcp"], method: "POST", path: "/api/v1/reports/{id}/seen" }))).toBe(false);
  });

  it("gives every tool annotations and its operation's stability level in _meta, with its description and lowered schemas", () => {
    const catalog = defineCatalog([tool({ stability: "beta" }), read()]);
    const listing = toolListing(catalog);
    expect(listing.map(({ name }) => name)).toEqual(["file_report", "get_report"]);
    expect(listing[0]).toMatchObject({
      name: "file_report",
      description: "File a report on a request.",
      annotations: { readOnlyHint: false },
      _meta: { [STABILITY_META_KEY]: "beta" },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(listing[1]).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { [STABILITY_META_KEY]: "alpha" } });
    expect(STABILITY_META_KEY).toBe("com.tiehall/stability");
  });

  it("gives the real catalog's get_request the read-only hint, and claim not", () => {
    const byName = new Map(toolListing(CATALOG).map((listed) => [listed.name, listed]));
    expect(byName.get("get_request")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("claim")?.annotations.readOnlyHint).toBe(false);
    for (const listed of byName.values()) {
      const definition = CATALOG.commands.find(({ tool: name }) => name === listed.name);
      expect(listed._meta[STABILITY_META_KEY], listed.name).toBe(definition?.stability);
    }
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
    const committed = readFileSync(committedToolSnapshotPath(), "utf8");
    expect(committedToolSnapshotPath().endsWith("mcp/tools.json")).toBe(true);
    expect(toolSnapshotProblems((JSON.parse(committed) as { tools: never[] }).tools)).toEqual([]);
    expect(toolSnapshotDrift(CATALOG, committed)).toBeUndefined();
  });

  it("records each tool with its operation's stability level and, once deprecated, its deprecation dates", () => {
    const deprecated = { since: "2026-12-01", sunset: "2026-12-15" };
    const catalog = defineCatalog([tool({ stability: "beta", deprecated }), tool({ id: "reports.list", tool: "list_reports", input: z.object({}) })]);
    const [filed, listed] = toolSnapshot(catalog);
    expect(filed).toEqual({ ...toolDescriptions(catalog)[0], stability: "beta", deprecated });
    expect(listed).toEqual({ ...toolDescriptions(catalog)[1], stability: "alpha" });
    expect(Object.keys(listed ?? {})).not.toContain("deprecated");
    expect(toolSnapshot(catalog)).toBe(toolSnapshot(catalog));
    // The committed snapshot records every tool's level.
    const committed = JSON.parse(readFileSync(committedToolSnapshotPath(), "utf8")) as { tools: { name: string; stability?: string }[] };
    for (const { name, stability } of committed.tools) {
      expect(stability, name).toBe(CATALOG.commands.find(({ tool: toolName }) => toolName === name)?.stability);
    }
  });

  it("reports a tool change that was not regenerated, as a diff of the snapshot", () => {
    const catalog = defineCatalog([tool()]);
    const committed = serializeToolSnapshot(toolSnapshot(catalog));
    expect(toolSnapshotDrift(catalog, committed)).toBeUndefined();
    const changed = defineCatalog([tool({ summary: "File a bug or a feature report." })]);
    expect(toolSnapshotDrift(changed, committed)).toContain("pnpm mcp:generate");
    // A removed tool shows too, and so does a new level or a deprecation.
    expect(toolSnapshotDrift(defineCatalog([]), committed)).toContain("file_report");
    expect(toolSnapshotDrift(defineCatalog([tool({ stability: "beta" })]), committed)).toContain("file_report (changed)");
    expect(toolSnapshotDrift(defineCatalog([tool({ deprecated: { since: "2026-12-01" } })]), committed)).toContain("file_report (changed)");
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
