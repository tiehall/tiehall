import { z } from "zod";
import type { Catalog } from "./catalog.ts";
import { proposalAnswer } from "./proposals.ts";

// Where text people and other systems wrote sits in the JSON agents read
// (agent-safety: User text in JSON sits under untrusted objects; design.md,
// Design rules: Agent safety). Every operation offered on an agent surface
// returns output that an agent reads as JSON: over MCP as structured content,
// through the CLI's --json, and on /api/v1, which is also the JSON variant of
// a request URL. In that output, text a user or an outside system wrote sits
// under an object named `untrusted`, and what Tiehall states about a request,
// such as its key and its state, sits outside every such object.
//
// untrustedFieldProblems() walks each such operation's output schema, as JSON
// Schema, and names every place that breaks this:
// - a string outside `untrusted` whose content the schema does not close: a
//   string is closed when it is one of a fixed set of values (an enum or a
//   const), an id, a date or a date-time by its format, or an identifier whose
//   pattern is one the caller lists, such as a request key, a team key or a
//   GitHub login, none of which can hold a space;
// - a value outside `untrusted` that the schema leaves open, which could hold
//   any text, and a map outside `untrusted` whose keys it leaves open;
// - a property named `key` or `state` inside an `untrusted` object.
// A field it cannot tell is written by Tiehall counts as written by people, so
// a new output field that holds free text fails until it moves under
// `untrusted` or its schema closes it. A commitment's operation also answers
// with the proposal it created, which agents read too, so that is walked as
// well.

/** A place in an output schema that breaks the rule, with the operation and the path to it. */
export interface UntrustedFieldProblem {
  operation: string;
  path: string;
  problem: string;
}

type JsonSchema = Record<string, unknown>;

/** The formats of strings Tiehall writes itself: ids and dates. */
const CLOSED_FORMATS: ReadonlySet<string> = new Set(["uuid", "date-time", "date"]);

/** Properties that name what Tiehall states about a request, which never sit under `untrusted`. */
const TIEHALL_PROPERTIES: ReadonlySet<string> = new Set(["key", "state"]);

/** The output schemas agents read: each operation an agent surface offers, and the proposal a commitment's answers with. */
export function agentOutputSchemas(catalog: Catalog): { operation: string; schema: z.ZodType }[] {
  return catalog.commands
    .filter(({ surfaces }) => surfaces.length > 0)
    .flatMap(({ id, output, commitment }) => [
      { operation: id, schema: output },
      ...(commitment ? [{ operation: `${id} (202)`, schema: proposalAnswer as z.ZodType }] : []),
    ]);
}

/** The problems of every output schema agents read; none when each keeps the rule. */
export function untrustedFieldProblems(catalog: Catalog, identifiers: readonly RegExp[]): UntrustedFieldProblem[] {
  const patterns = new Set(identifiers.map(({ source }) => source));
  return agentOutputSchemas(catalog).flatMap(({ operation, schema }) =>
    outputSchemaProblems(schema, patterns).map((problem) => ({ operation, ...problem })),
  );
}

/** The problems of one output schema, by path; exported for the check's own tests. */
export function outputSchemaProblems(output: z.ZodType, identifierPatterns: ReadonlySet<string>): { path: string; problem: string }[] {
  const schema = z.toJSONSchema(output, { target: "draft-2020-12", io: "output", unrepresentable: "any" }) as JsonSchema;
  const defs = (schema["$defs"] ?? {}) as Record<string, JsonSchema>;
  const problems: { path: string; problem: string }[] = [];

  const walk = (node: JsonSchema, path: string, untrusted: boolean, refs: readonly string[]): void => {
    const ref = node["$ref"];
    if (typeof ref === "string") {
      if (refs.includes(ref)) return;
      const target = defs[ref.replace(/^#\/\$defs\//, "")];
      if (target === undefined) problems.push({ path, problem: `it names ${ref}, which the schema does not hold` });
      else walk(target, path, untrusted, [...refs, ref]);
      return;
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      for (const branch of (node[keyword] ?? []) as JsonSchema[]) walk(branch, path, untrusted, refs);
    }
    const types = typesOf(node);
    const properties = (node["properties"] ?? {}) as Record<string, JsonSchema>;
    for (const [name, child] of Object.entries(properties)) {
      if (untrusted && TIEHALL_PROPERTIES.has(name)) {
        problems.push({ path: `${path}.${name}`, problem: `${name} is Tiehall's to state, so it sits outside every untrusted object` });
      }
      walk(child, `${path}.${name}`, untrusted || name === "untrusted", refs);
    }
    const additional = node["additionalProperties"];
    if (typeof additional === "object" && additional !== null) {
      if (!untrusted && !isClosedKeys(node["propertyNames"], identifierPatterns)) {
        problems.push({ path: `${path}.*`, problem: "its keys could be any text, so the map sits under an untrusted object" });
      }
      walk(additional as JsonSchema, `${path}.*`, untrusted, refs);
    }
    if (typeof node["items"] === "object" && node["items"] !== null) walk(node["items"] as JsonSchema, `${path}[]`, untrusted, refs);
    for (const item of (node["prefixItems"] ?? []) as JsonSchema[]) walk(item, `${path}[]`, untrusted, refs);
    if (untrusted) return;
    if (types.includes("string") && !isClosedString(node, identifierPatterns)) {
      problems.push({ path, problem: "it could hold text people or other systems wrote, so it sits under an untrusted object" });
    }
    if (isOpen(node)) problems.push({ path, problem: "it could hold any value, text included, so it sits under an untrusted object" });
  };

  walk(schema, "$", false, []);
  return problems;
}

function typesOf(node: JsonSchema): string[] {
  const type = node["type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? (type as string[]) : [];
}

/** A string whose content the schema closes: a fixed value, an id or a date, or a listed identifier. */
function isClosedString(node: JsonSchema, identifierPatterns: ReadonlySet<string>): boolean {
  if (Array.isArray(node["enum"]) || "const" in node) return true;
  if (typeof node["format"] === "string" && CLOSED_FORMATS.has(node["format"])) return true;
  return typeof node["pattern"] === "string" && identifierPatterns.has(node["pattern"]);
}

/** Map keys the schema closes the same way as strings. */
function isClosedKeys(propertyNames: unknown, identifierPatterns: ReadonlySet<string>): boolean {
  return typeof propertyNames === "object" && propertyNames !== null && isClosedString(propertyNames as JsonSchema, identifierPatterns);
}

/** A schema that constrains nothing, such as z.unknown(), which accepts any value. */
function isOpen(node: JsonSchema): boolean {
  const constraining = ["type", "enum", "const", "$ref", "anyOf", "oneOf", "allOf", "properties", "items", "not"];
  return !constraining.some((keyword) => keyword in node);
}
