import { z } from "zod";
import { serializeDocument } from "./openapi.ts";
import { packet, PACKET_COMPONENT, PACKET_SCHEMA_ID } from "./packet.ts";

// One definition for the schema and the API (handoff-packet: One definition
// for the schema and the API; handoff-packet: The packet format; handoff-packet:
// Open objects, strict server; design.md, Technical decisions: T11). The packet
// JSON Schema, draft 2020-12, lives in the Apache-2.0 schema directory as
// packages/packet/schema/v1-beta.json, generated from the catalog's packet
// definition in input mode, so its objects are open; the OpenAPI document's
// packet component, Packet, is generated from the same definition. CI checks,
// on every pull request:
// - that the committed schema file is the one the definition generates;
// - that the file and the component define the same fields with the same
//   types: they are equal once the file's $schema and $id are set aside;
// - that no object of the file forbids additional properties;
// - that the document has one packet component, which every operation that
//   takes or returns a packet, such as adding a revision and reading a
//   packet, refers to.

type Json = Record<string, unknown>;

/** The committed schema file, in the Apache-2.0 schema directory. */
const COMMITTED_NAME = "packages/packet/schema/v1-beta.json";

/** The packet JSON Schema, draft 2020-12, with the beta $id, generated from the packet definition. */
export function packetJsonSchema(): Json {
  const { $schema, ...generated } = z.toJSONSchema(packet, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }) as Json;
  // The root is an object, as the OpenAPI component of a union on a property says too.
  return { $schema, $id: PACKET_SCHEMA_ID, type: "object", ...generated };
}

/** What differs between the committed schema file and the one the definition generates; undefined when nothing does. */
export function packetSchemaDrift(committed: string): string | undefined {
  const generated = serializeDocument(packetJsonSchema());
  if (generated === committed) return undefined;
  const was = committed.split("\n");
  const is = generated.split("\n");
  const line = was.findIndex((text, index) => text !== is[index]);
  const at = line === -1 ? was.length : line;
  return [
    `${COMMITTED_NAME} differs from the schema the packet definition generates. Run \`pnpm packet:generate\` and commit the file.`,
    `First difference, at line ${at + 1}:`,
    `  committed: ${was[at]?.trim() ?? "(end of file)"}`,
    `  generated: ${is[at]?.trim() ?? "(end of file)"}`,
  ].join("\n");
}

/** Every rule the schema file and the OpenAPI document break together, as a sentence; none when they keep them. */
export function packetSchemaProblems(schemaFile: Json, document: Json): string[] {
  const problems: string[] = [];
  const components = (((document["components"] ?? {}) as Json)["schemas"] ?? {}) as Record<string, Json>;
  const component = components[PACKET_COMPONENT];
  if (component === undefined) {
    problems.push(`The OpenAPI document has no packet component ${PACKET_COMPONENT}.`);
  } else {
    const { $schema: _schema, $id: _id, ...fields } = schemaFile;
    const difference = firstDifference(fields, component, "");
    if (difference !== undefined) {
      const [path, file, api] = difference;
      problems.push(
        `The JSON Schema file and the OpenAPI component ${PACKET_COMPONENT} differ at ${path || "/"}: the file has ${shown(file)}, the component ${shown(api)}.`,
      );
    }
  }
  for (const [path, node] of objectNodes(schemaFile, "")) {
    if (node["additionalProperties"] === false || node["unevaluatedProperties"] === false) {
      problems.push(`The JSON Schema file forbids additional properties at ${path || "/"}; packet objects stay open.`);
    }
  }
  const packetComponents = Object.keys(components).filter((name) => name.startsWith(PACKET_COMPONENT));
  for (const name of packetComponents.filter((name) => name !== PACKET_COMPONENT)) {
    problems.push(`The OpenAPI document has a second packet component, ${name}; requests and responses use the one component ${PACKET_COMPONENT}.`);
  }
  const uses = packetComponentUses(document, components, new Set(packetComponents));
  const onPacket = uses.filter(({ component: used }) => used === PACKET_COMPONENT).map(({ operationId }) => operationId);
  for (const { operationId, component: used } of uses.filter(({ component: other }) => other !== PACKET_COMPONENT)) {
    const others = onPacket.length === 0 ? "" : `, while ${[...new Set(onPacket)].join(", ")} uses ${PACKET_COMPONENT}`;
    problems.push(`${operationId} uses the packet component ${used}${others}; every operation uses the one component ${PACKET_COMPONENT}.`);
  }
  return problems;
}

/** Each operation's use of a packet component, through its parameters, body or answers, in the document's order. */
function packetComponentUses(document: Json, components: Record<string, Json>, packetComponents: ReadonlySet<string>) {
  const uses: { operationId: string; component: string }[] = [];
  const paths = (document["paths"] ?? {}) as Record<string, Record<string, Json>>;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const operationId = typeof operation["operationId"] === "string" ? operation["operationId"] : `${method.toUpperCase()} ${path}`;
      const found = new Set<string>();
      collectRefs(operation, components, found, new Set());
      for (const name of found) if (packetComponents.has(name)) uses.push({ operationId, component: name });
    }
  }
  return uses;
}

/** The names of the components a value refers to, directly or through other components. */
function collectRefs(value: unknown, components: Record<string, Json>, found: Set<string>, visited: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, components, found, visited);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    const name = key === "$ref" && typeof item === "string" ? /^#\/components\/schemas\/(.+)$/.exec(item)?.[1] : undefined;
    if (name !== undefined) {
      found.add(name);
      if (!visited.has(name)) {
        visited.add(name);
        collectRefs(components[name], components, found, visited);
      }
    } else {
      collectRefs(item, components, found, visited);
    }
  }
}

/** Every object of a JSON value, with its JSON Pointer. */
function objectNodes(value: unknown, path: string): [string, Json][] {
  if (Array.isArray(value)) return value.flatMap((item, index) => objectNodes(item, `${path}/${index}`));
  if (typeof value !== "object" || value === null) return [];
  return [[path, value as Json], ...Object.entries(value).flatMap(([key, item]) => objectNodes(item, `${path}/${pointer(key)}`))];
}

/** The first place, by JSON Pointer, where two JSON values differ, with each side's value there. */
function firstDifference(a: unknown, b: unknown, path: string): [string, unknown, unknown] | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const found = firstDifference(a[index], b[index], `${path}/${index}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const found = firstDifference(a[key], b[key], `${path}/${pointer(key)}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? undefined : [path, a, b];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function shown(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}
