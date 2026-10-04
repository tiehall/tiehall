import { packetValidator } from "@tiehall/packet";
import type { FixtureVersion } from "./packet-compat.ts";

// The packet's forward compatibility after publication (handoff-packet: v1
// only gains optional fields after publication; design.md, Design rules:
// Handoff packet). From publication on, a v1.x release only adds optional
// fields: it adds no required field, removes no field and narrows no type, a
// packet built against a newer v1.x release validates against every older
// one, and every conformance fixture that ever validated still does. Since a
// packet built against the newer release must validate against the older
// ones, widening a field's constraint breaks the rule as surely as narrowing
// it: a wider enum or a longer maximum lets a newer packet fail an older
// release. So the check holds every constraint an older release puts on a
// field to exactly what that release says, and lets a candidate, the schema
// the next release would publish, add only optional fields where the older
// release leaves objects open. It runs two ways:
// - structurally, the candidate against every published release
//   (schemaChanges): each field a release defines keeps its constraints, its
//   required fields and its variants, and annotations (descriptions, titles,
//   x- keywords and the $id) may change;
// - by the fixtures: every version of every valid fixture that ever
//   validated against a published release validates against the candidate,
//   and every valid fixture of the candidate validates against every
//   published release.
// Before the first release, v1.0, nothing is published and the check passes;
// until then a breaking packet change needs its notice instead, which
// packet-compat.ts checks (handoff-packet: Breaking packet changes before
// publication).

type Json = Record<string, unknown>;

/** A published release of the packet schema: its version, such as 1.0, and its file's text. */
export interface PacketRelease {
  version: string;
  text: string;
}

export interface ForwardInput {
  /** Every published v1.x release, oldest first. */
  releases: readonly PacketRelease[];
  /** The schema the next release would publish. */
  candidate: string;
  /** The candidate's valid fixtures, by name, such as valid/request-packet.json. */
  candidateFixtures: Readonly<Record<string, string>>;
  /** Every version of every valid fixture the repository's history holds. */
  fixturesEver: readonly FixtureVersion[];
}

export interface ForwardResult {
  passed: boolean;
  problems: string[];
}

/** Keywords that describe a schema and constrain nothing, which a release may change. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["$id", "$comment", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly"]);

/** Keywords whose value is one schema, compared field by field. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]);

/** Keywords whose value is a list of schemas, the variants of a packet among them. */
const VARIANT_KEYWORDS: ReadonlySet<string> = new Set(["oneOf", "anyOf", "allOf", "prefixItems"]);

/** Keywords whose value is a set: the same members in any order are the same constraint. */
const SET_KEYWORDS: ReadonlySet<string> = new Set(["required", "type", "enum"]);

/** Keywords by which an object constrains the fields its properties do not define. */
const UNKNOWN_FIELD_KEYWORDS: readonly string[] = ["additionalProperties", "patternProperties", "propertyNames", "unevaluatedProperties"];

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnnotation(keyword: string): boolean {
  return ANNOTATIONS.has(keyword) || keyword.startsWith("x-");
}

/** A JSON value as text with every object's keys sorted, so equal values read the same. */
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (!isObject(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]));
  };
  return JSON.stringify(sorted(value)) ?? "undefined";
}

/** A constraint's value as the problems show it, compact and cut to a readable length. */
function shown(value: unknown): string {
  const text = value === undefined ? "nothing" : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Whether two values of a set keyword hold the same members. */
function sameSet(a: unknown, b: unknown): boolean {
  const members = (value: unknown) => (Array.isArray(value) ? value : [value]).map(canonical).sort();
  return canonical(members(a)) === canonical(members(b));
}

/** A field's name as the problems give it: its path from the packet's top, after the variant it is in. */
function fieldName(path: string): string {
  return path === "" ? "the packet" : path;
}

/** The property that tells the variants of a list apart by its const in each, if one does in both lists. */
function discriminator(older: readonly unknown[], newer: readonly unknown[]): string | undefined {
  const consts = (variants: readonly unknown[], key: string) =>
    variants.map((variant) => (isObject(variant) && isObject(variant["properties"]) && isObject(variant["properties"][key]) ? variant["properties"][key]["const"] : undefined));
  const first = older[0];
  if (!isObject(first) || !isObject(first["properties"])) return undefined;
  return Object.keys(first["properties"])
    .sort()
    .find((key) =>
      [older, newer].every((variants) => {
        const values = consts(variants, key);
        return values.every((value) => typeof value === "string") && new Set(values).size === values.length;
      }),
    );
}

/** Joins a path and a field's name. */
function child(path: string, name: string): string {
  return path === "" ? name : path.endsWith(" ") ? `${path}${name}` : `${path}.${name}`;
}

/**
 * How a newer schema changes what an older one says about the packet: each
 * added required field, removed field, changed constraint and changed
 * variant, as a sentence. Empty when the newer schema only adds optional
 * fields where the older one leaves objects open, and changes annotations.
 */
export function schemaChanges(older: unknown, newer: unknown, release = "the older release"): string[] {
  const problems: string[] = [];
  compare(older, newer, "", release, problems);
  return problems;
}

function compare(older: unknown, newer: unknown, path: string, release: string, problems: string[]): void {
  if (!isObject(older) || !isObject(newer)) {
    if (canonical(older) !== canonical(newer)) problems.push(`changes the schema of ${fieldName(path)} from ${shown(older)} to ${shown(newer)}.`);
    return;
  }
  const keywords = [...new Set([...Object.keys(older), ...Object.keys(newer)])].filter((keyword) => !isAnnotation(keyword)).sort();
  for (const keyword of keywords) {
    const was = older[keyword];
    const is = newer[keyword];
    if (keyword === "properties") {
      compareProperties(older, newer, path, release, problems);
    } else if (keyword === "required") {
      const before = new Set(Array.isArray(was) ? (was as string[]) : []);
      const after = new Set(Array.isArray(is) ? (is as string[]) : []);
      for (const name of [...after].filter((each) => !before.has(each)).sort()) problems.push(`adds the required field ${child(path, name)}.`);
      for (const name of [...before].filter((each) => !after.has(each)).sort()) {
        problems.push(`makes the field ${child(path, name)} optional, so a packet without it, built against the candidate, fails ${release}.`);
      }
    } else if (was === undefined) {
      problems.push(`adds ${keyword} to ${fieldName(path)}: ${shown(is)}.`);
    } else if (is === undefined) {
      problems.push(`drops ${keyword} from ${fieldName(path)}, which was ${shown(was)}, so a packet built against the candidate can fail ${release}.`);
    } else if (SCHEMA_KEYWORDS.has(keyword)) {
      const where = keyword === "items" ? `${path}[]` : keyword === "additionalProperties" ? child(path, "*") : `${fieldName(path)} (${keyword})`;
      compare(was, is, where, release, problems);
    } else if (VARIANT_KEYWORDS.has(keyword) && Array.isArray(was) && Array.isArray(is)) {
      compareVariants(was, is, path, release, problems);
    } else if (SET_KEYWORDS.has(keyword) ? !sameSet(was, is) : canonical(was) !== canonical(is)) {
      problems.push(`changes ${keyword} of ${fieldName(path)} from ${shown(was)} to ${shown(is)}.`);
    }
  }
}

function compareProperties(older: Json, newer: Json, path: string, release: string, problems: string[]): void {
  const was = isObject(older["properties"]) ? older["properties"] : {};
  const is = isObject(newer["properties"]) ? newer["properties"] : {};
  for (const name of Object.keys(was).sort()) {
    if (!Object.hasOwn(is, name)) problems.push(`removes the field ${child(path, name)}.`);
    else compare(was[name], is[name], child(path, name), release, problems);
  }
  const constrained = UNKNOWN_FIELD_KEYWORDS.some((keyword) => older[keyword] !== undefined && older[keyword] !== true && canonical(older[keyword]) !== "{}");
  for (const name of Object.keys(is).filter((each) => !Object.hasOwn(was, each)).sort()) {
    if (constrained) problems.push(`adds the field ${child(path, name)} where ${release} constrains the fields it does not define.`);
  }
}

function compareVariants(older: readonly unknown[], newer: readonly unknown[], path: string, release: string, problems: string[]): void {
  const key = discriminator(older, newer);
  const prefix = path === "" ? "" : `${path} `;
  if (key === undefined) {
    if (older.length !== newer.length) {
      problems.push(`changes the number of variants of ${fieldName(path)} from ${older.length} to ${newer.length}.`);
      return;
    }
    older.forEach((variant, index) => compare(variant, newer[index], `${prefix}(variant ${index + 1}) `, release, problems));
    return;
  }
  const byConst = (variants: readonly unknown[]) =>
    new Map(variants.map((variant) => [String(((variant as Json)["properties"] as Record<string, Json>)[key]?.["const"]), variant]));
  const before = byConst(older);
  const after = byConst(newer);
  for (const [value, variant] of before) {
    const now = after.get(value);
    if (now === undefined) problems.push(`removes the variant (${key}: ${value}).`);
    else compare(variant, now, `${prefix}(${key}: ${value}) `, release, problems);
  }
  for (const value of after.keys()) {
    if (!before.has(value)) problems.push(`adds the variant (${key}: ${value}), whose packets ${release} refuses.`);
  }
}

/** A validator of a schema's text, or the reason it cannot be one. */
function validatorOf(text: string, name: string): ((packet: unknown) => boolean) | string {
  try {
    return packetValidator(JSON.parse(text) as Json);
  } catch (error) {
    return `${name} is not a schema the packet validator compiles: ${(error as Error).message}`;
  }
}

/** A JSON text, parsed; undefined when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The forward-compatibility check of a candidate against every published release. */
export function checkPacketForward({ releases, candidate, candidateFixtures, fixturesEver }: ForwardInput): ForwardResult {
  const problems: string[] = [];
  if (releases.length === 0) return { passed: true, problems };

  const validate = validatorOf(candidate, "The candidate");
  if (typeof validate === "string") return { passed: false, problems: [validate] };
  const published: { version: string; validate: (packet: unknown) => boolean }[] = [];
  for (const { version, text } of releases) {
    const release = `v${version}`;
    const old = validatorOf(text, release);
    if (typeof old === "string") {
      problems.push(old);
      continue;
    }
    published.push({ version: release, validate: old });
    problems.push(...schemaChanges(parsed(text), parsed(candidate), release).map((change) => `Against ${release}: ${change}`));
  }

  // Every version of a valid fixture that validated against a release still validates.
  const seen = new Set<string>();
  const versions: FixtureVersion[] = [...fixturesEver, ...Object.entries(candidateFixtures).map(([name, text]) => ({ name, text }))];
  for (const { name, text, commit } of versions) {
    const packet = parsed(text);
    const key = `${name}\n${canonical(packet)}`;
    if (packet === undefined || seen.has(key)) continue;
    seen.add(key);
    const valid = published.find((release) => release.validate(packet));
    if (valid !== undefined && !validate(packet)) {
      problems.push(`${name}${commit === undefined ? "" : ` as of ${commit.slice(0, 12)}`} validated against ${valid.version} and fails against the candidate.`);
    }
  }

  // A packet built against the candidate validates against every older release.
  for (const [name, text] of Object.entries(candidateFixtures).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const packet = parsed(text);
    if (packet === undefined || !validate(packet)) continue;
    for (const release of published) {
      if (!release.validate(packet)) {
        problems.push(`${name}, a valid fixture of the candidate, fails against ${release.version}: a packet built against the candidate must validate against every older release.`);
      }
    }
  }
  return { passed: problems.length === 0, problems };
}
