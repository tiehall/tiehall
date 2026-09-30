import { z } from "zod";
import type { Catalog } from "./catalog.ts";
import type { CommandDefinition, StabilityLevel } from "./command.ts";
import { proposalAnswer } from "./proposals.ts";

// Tool schemas that current clients accept (agent-surfaces: Tool schemas that
// current clients accept; public-api: MCP tools follow the same compatibility
// rules; design.md, Technical decisions: T9). MCP tool schemas are produced
// apart from the OpenAPI ones, in JSON Schema 2020-12, and lowered, because
// Claude Code silently drops a tool with composition at its root and Codex
// turns a $ref parameter into a string:
// - every $ref is inlined, so no $ref and no $defs remain, and a schema that
//   refers to itself is refused;
// - the root is an object with no anyOf, oneOf or allOf: a union of variants
//   becomes one object whose `kind` is an enum of the variants' kinds and
//   whose other fields are optional, each saying which kind it is for, unless
//   every variant requires it; an intersection of objects becomes one object;
// - an input's variants are strict objects, so execute(), which still
//   validates with the zod union, refuses an input that mixes them; a key
//   that no variant has is dropped before parsing, as for any other input
//   (dropUnknownVariantKeys), so provenance a payload claims is ignored and
//   never refused (requests: Provenance is stamped by the server);
// - an output leaves additionalProperties: false out, so it can gain fields;
// - a commitment's output also admits { proposal }, which a call that makes a
//   commitment answers with instead (agent-surfaces: Commitment tools return
//   proposals): one object with the output's fields and `proposal`, none of
//   them required, since clients check a result's structured content against
//   the listed output schema.
// The schemas are computed once per catalog. Their snapshot, mcp/tools.json,
// is committed; CI regenerates it and lints it on every pull request, so every
// change to a tool is reviewed as a diff of that file.

export type JsonSchema = Record<string, unknown>;

/** A schema that cannot be lowered, saying why. */
export class ToolSchemaError extends Error {
  override name = "ToolSchemaError";
}

/** A tool as the MCP tool list shows it. */
export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const COMPOSITION = ["anyOf", "oneOf", "allOf"] as const;

/** A tool's input or output schema, lowered. */
export function lowerToolSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  if (io === "input") checkStrictVariants(schema);
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }) as JsonSchema;
  const defs = (generated["$defs"] ?? {}) as Record<string, JsonSchema>;
  const { $schema: _schema, $defs: _defs, ...root } = generated;
  let lowered = inline(root, defs, []) as JsonSchema;
  lowered = lowerRoot(lowered);
  if (io === "output") lowered = withoutClosedObjects(lowered) as JsonSchema;
  if (lowered["type"] !== "object") throw new ToolSchemaError("A tool schema has a root of type object.");
  return lowered;
}

/**
 * The input without the keys that no variant of its union has, before it is
 * parsed: a union of strict variants refuses a key of another variant, which
 * mixes them, and every other input drops a key its schema does not know, so
 * this one does too. An input that is not an object, or whose schema has no
 * strict variants, is returned as it is.
 */
export function dropUnknownVariantKeys(schema: z.ZodType, input: unknown): unknown {
  if (!(schema instanceof z.ZodDiscriminatedUnion) || typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const options = schema.def.options as readonly z.ZodType[];
  const strict = options.every((option) => option instanceof z.ZodObject && option.def.catchall instanceof z.ZodNever);
  if (!strict) return input;
  const known = new Set(options.flatMap((option) => Object.keys((option as z.ZodObject).shape)));
  return Object.fromEntries(Object.entries(input).filter(([key]) => known.has(key)));
}

/** A commitment tool's output: the operation's own output or, for a call that made a commitment, only the proposal. */
function commitmentOutput(output: z.ZodType): JsonSchema {
  const own = lowerToolSchema(output, "output");
  const answer = lowerToolSchema(proposalAnswer, "output");
  const { type: _type, properties, required: _required, description, ...rest } = own;
  const proposal = (answer["properties"] as Record<string, JsonSchema>)["proposal"];
  const either =
    "A call that makes a commitment returns only proposal, the proposal it created, which people confirm in the web UI, instead of the fields above.";
  return {
    type: "object",
    ...rest,
    description: typeof description === "string" ? `${description} ${either}` : `The operation's result. ${either}`,
    properties: { ...(properties as Record<string, JsonSchema>), proposal },
  };
}

/** A root union's variants, for an input, are strict objects on `kind`. */
function checkStrictVariants(schema: z.ZodType): void {
  if (!(schema instanceof z.ZodUnion)) return;
  if (!(schema instanceof z.ZodDiscriminatedUnion) || schema.def.discriminator !== "kind") {
    throw new ToolSchemaError("A tool input with variants is a union on kind, so that it lowers to a kind enum.");
  }
  for (const option of schema.def.options) {
    const strict = option instanceof z.ZodObject && option.def.catchall instanceof z.ZodNever;
    if (!strict) throw new ToolSchemaError("Each variant of a tool input is a strict object, so that an input that mixes variants is refused.");
  }
}

/** The schema with every $ref replaced by what it names. */
function inline(value: unknown, defs: Record<string, JsonSchema>, trail: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => inline(item, defs, trail));
  if (typeof value !== "object" || value === null) return value;
  const node = value as JsonSchema;
  const ref = node["$ref"];
  if (typeof ref === "string") {
    if (ref === "#" || trail.includes(ref)) throw new ToolSchemaError("A tool schema refers to itself, which it cannot without a $ref.");
    const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
    const target = name === undefined ? undefined : defs[decodeURIComponent(name.replace(/~1/g, "/").replace(/~0/g, "~"))];
    if (target === undefined) throw new ToolSchemaError(`A tool schema names ${ref}, which it does not hold.`);
    const { $ref: _ref, ...siblings } = node;
    return { ...(inline(target, defs, [...trail, ref]) as JsonSchema), ...(inline(siblings, defs, trail) as JsonSchema) };
  }
  return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, inline(item, defs, trail)]));
}

/** The root as one object: a union on kind merged, an intersection of objects merged. */
function lowerRoot(schema: JsonSchema): JsonSchema {
  const union = (schema["oneOf"] ?? schema["anyOf"]) as JsonSchema[] | undefined;
  if (union !== undefined) {
    const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = schema;
    return { ...mergeVariants(union.map(lowerRoot)), ...rest };
  }
  const all = schema["allOf"] as JsonSchema[] | undefined;
  if (all !== undefined) {
    const { allOf: _allOf, ...rest } = schema;
    return mergeObjects([rest, ...all.map(lowerRoot)].filter((part) => Object.keys(part).length > 0));
  }
  return schema;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema["type"] === "object" && COMPOSITION.every((key) => schema[key] === undefined);
}

/** The variants of a union on kind, as one object with a kind enum and optional fields. */
function mergeVariants(variants: JsonSchema[]): JsonSchema {
  const kinds: string[] = [];
  const fields = new Map<string, { schemas: JsonSchema[]; kinds: string[]; requiredIn: string[] }>();
  let kindSchema: JsonSchema = {};
  for (const variant of variants) {
    const properties = (variant["properties"] ?? {}) as Record<string, JsonSchema>;
    const kind = properties["kind"]?.["const"];
    if (!isObjectSchema(variant) || typeof kind !== "string") {
      throw new ToolSchemaError("A tool schema with variants is a union on kind of objects, each with its own kind.");
    }
    kinds.push(kind);
    const { const: _const, type: _type, ...kindRest } = properties["kind"] ?? {};
    kindSchema = { ...kindSchema, ...kindRest };
    const required = new Set((variant["required"] ?? []) as string[]);
    for (const [name, field] of Object.entries(properties)) {
      if (name === "kind") continue;
      const entry = fields.get(name) ?? { schemas: [], kinds: [], requiredIn: [] };
      if (!entry.schemas.some((known) => JSON.stringify(known) === JSON.stringify(field))) entry.schemas.push(field);
      entry.kinds.push(kind);
      if (required.has(name)) entry.requiredIn.push(kind);
      fields.set(name, entry);
    }
  }
  const properties: Record<string, JsonSchema> = { kind: { type: "string", enum: kinds, ...kindSchema } };
  const required = ["kind"];
  for (const [name, { schemas, kinds: usedBy, requiredIn }] of fields) {
    const field: JsonSchema = schemas.length === 1 ? { ...schemas[0] } : { anyOf: schemas };
    if (requiredIn.length === kinds.length) required.push(name);
    const note = variantNote(usedBy, requiredIn, kinds.length);
    if (note !== undefined) field["description"] = typeof field["description"] === "string" ? `${field["description"]} ${note}` : note;
    properties[name] = field;
  }
  const closed = variants.every((variant) => variant["additionalProperties"] === false);
  return { type: "object", properties, required, ...(closed ? { additionalProperties: false } : {}) };
}

/** Objects that all hold, as one object. */
function mergeObjects(parts: JsonSchema[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const rest: JsonSchema = {};
  for (const part of parts) {
    if (!isObjectSchema(part)) throw new ToolSchemaError("A tool schema that combines schemas at its root combines objects only.");
    const { type: _type, properties: partProperties, required: partRequired, additionalProperties: _closed, ...other } = part;
    Object.assign(properties, partProperties);
    for (const name of (partRequired ?? []) as string[]) required.add(name);
    Object.assign(rest, other);
  }
  return { type: "object", ...rest, properties, ...(required.size === 0 ? {} : { required: [...required] }) };
}

/** Which kinds a field is for and required in, in words; none for a field every kind has and requires, or none requires. */
function variantNote(usedBy: readonly string[], requiredIn: readonly string[], kindCount: number): string | undefined {
  if (usedBy.length === kindCount) {
    return requiredIn.length === 0 || requiredIn.length === kindCount ? undefined : `Required when kind is ${list(requiredIn)}.`;
  }
  const required =
    requiredIn.length === 0 ? "" : requiredIn.length === usedBy.length ? ", and required then" : `, and required when it is ${list(requiredIn)}`;
  return `Only when kind is ${list(usedBy)}${required}.`;
}

function list(kinds: readonly string[]): string {
  return kinds.length === 1 ? (kinds[0] ?? "") : `${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1) ?? ""}`;
}

/** The schema without additionalProperties: false anywhere, so an output can gain fields. */
function withoutClosedObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClosedObjects);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !(key === "additionalProperties" && item === false))
      .map(([key, item]) => [key, withoutClosedObjects(item)]),
  );
}

const DESCRIPTIONS = new WeakMap<Catalog, readonly ToolDescription[]>();

/** Every tool the catalog offers on MCP, sorted by name, with its lowered schemas; computed once per catalog. */
export function toolDescriptions(catalog: Catalog): readonly ToolDescription[] {
  let tools = DESCRIPTIONS.get(catalog);
  if (tools === undefined) {
    tools = catalog.commands
      .filter(({ surfaces, tool }) => surfaces.includes("mcp") && tool !== undefined)
      .map((definition) => ({
        name: definition.tool ?? "",
        description: definition.summary,
        inputSchema: lowerToolSchema(definition.input, "input"),
        outputSchema: definition.commitment ? commitmentOutput(definition.output) : lowerToolSchema(definition.output, "output"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    DESCRIPTIONS.set(catalog, tools);
  }
  return tools;
}

// Tool annotations and stability levels (agent-surfaces: Tool annotations and
// stability levels; design.md, Decisions this change rests on: D28 #65). The
// tool list gives every tool MCP annotations and, in its _meta, the stability
// level of its operation, under Tiehall's own key. A tool's read-only hint is
// true only when its operation only reads: it needs no scope but
// requests:read, and, if REST offers it too, REST offers it with GET. So a
// tool that changes a request never carries it, and neither does one that
// changes anything else, such as a reader's cursor.

/** The _meta key under which every tool states its operation's stability level. */
export const STABILITY_META_KEY = "com.tiehall/stability";

/** Whether a tool only reads: its operation needs no scope but requests:read, and is offered on REST, if at all, with GET. */
export function toolReadsOnly(definition: CommandDefinition): boolean {
  const readScopeOnly = definition.scopes.every((scope) => scope === "requests:read");
  return readScopeOnly && (definition.method === undefined || definition.method === "GET");
}

/** A tool as the MCP tool list shows it, with its annotations and its stability level in _meta. */
export interface ToolListing extends ToolDescription {
  annotations: { readOnlyHint: boolean };
  _meta: { [STABILITY_META_KEY]: StabilityLevel };
}

const LISTINGS = new WeakMap<Catalog, readonly ToolListing[]>();

/** Every tool the catalog offers on MCP, sorted by name, as the tool list shows it; computed once per catalog. */
export function toolListing(catalog: Catalog): readonly ToolListing[] {
  let listing = LISTINGS.get(catalog);
  if (listing === undefined) {
    const byTool = new Map(catalog.commands.map((definition) => [definition.tool, definition]));
    listing = toolDescriptions(catalog).map((description) => {
      const definition = byTool.get(description.name);
      if (definition === undefined) throw new Error(`The tool ${description.name} has no operation.`);
      return {
        ...description,
        annotations: { readOnlyHint: toolReadsOnly(definition) },
        _meta: { [STABILITY_META_KEY]: definition.stability },
      };
    });
    LISTINGS.set(catalog, listing);
  }
  return listing;
}

/** The snapshot as it is committed: `{ "tools": [...] }` with every object's keys sorted, and a final newline. */
export function serializeToolSnapshot(tools: readonly ToolDescription[]): string {
  return `${JSON.stringify(sortKeys({ tools }), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/** What differs between the committed snapshot and the one the catalog generates; undefined when nothing does. */
export function toolSnapshotDrift(catalog: Catalog, committed: string): string | undefined {
  const tools = toolDescriptions(catalog);
  const generated = serializeToolSnapshot(tools);
  if (generated === committed) return undefined;
  const byName = (list: readonly { name: string }[]) => new Map(list.map((tool) => [tool.name, JSON.stringify(sortKeys(tool))]));
  let before = new Map<string, string>();
  try {
    before = byName((JSON.parse(committed) as { tools: { name: string }[] }).tools);
  } catch {
    // A snapshot that does not parse differs everywhere; the lines below show where.
  }
  const after = byName(tools);
  const changes = [
    ...[...after.keys()].filter((name) => !before.has(name)).map((name) => `${name} (added)`),
    ...[...before.keys()].filter((name) => !after.has(name)).map((name) => `${name} (removed)`),
    ...[...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)).map((name) => `${name} (changed)`),
  ];
  const was = committed.split("\n");
  const is = generated.split("\n");
  const line = was.findIndex((text, index) => text !== is[index]);
  const at = line === -1 ? was.length : line;
  return [
    "mcp/tools.json differs from the tools the catalog generates. Run `pnpm mcp:generate` and commit the file, so the change to the tools is reviewed as a diff.",
    ...(changes.length === 0 ? [] : [`Tools that differ: ${changes.sort().join(", ")}.`]),
    `First difference, at line ${at + 1}:`,
    `  committed: ${was[at]?.trim() ?? "(end of file)"}`,
    `  generated: ${is[at]?.trim() ?? "(end of file)"}`,
  ].join("\n");
}

/** The lint of a snapshot: no $ref and no $defs anywhere, and a root of type object with no composition, in every schema. */
export function toolSnapshotProblems(tools: readonly { name: string; inputSchema: unknown; outputSchema: unknown }[]): string[] {
  const problems: string[] = [];
  for (const tool of tools) {
    for (const key of ["inputSchema", "outputSchema"] as const) {
      const schema = tool[key];
      const problem = (text: string) => problems.push(`${tool.name}: its ${key}${text}`);
      if (typeof schema !== "object" || schema === null || (schema as JsonSchema)["type"] !== "object") problem("'s root is not of type object.");
      for (const composition of COMPOSITION) {
        if (typeof schema === "object" && schema !== null && composition in schema) problem(` has ${composition} at its root.`);
      }
      for (const found of forbiddenKeys(schema, [])) problem(found);
    }
  }
  return problems;
}

function forbiddenKeys(value: unknown, path: readonly string[]): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, [...path, String(index)]));
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref") found.push(` has a $ref at ${path.length === 0 ? "its root" : path.join(".")}.`);
    else if (key === "$defs") found.push(path.length === 0 ? " has $defs." : ` has $defs at ${path.join(".")}.`);
    else found.push(...forbiddenKeys(item, [...path, key]));
  }
  return found;
}
