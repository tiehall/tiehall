// What changed between two JSON values, as an RFC 6902 JSON Patch
// (handoff-packet: What changed since revision N; design.md, Decisions this
// change rests on: D28 #25). A pure module. jsonPatch(from, to) gives the
// operations that, applied in order, turn `from` into `to`, using only add,
// remove and replace, with paths as RFC 6901 JSON Pointers:
// - two values that are the same JSON, whatever the order of an object's
//   keys, give no operation;
// - between two objects: each key only `from` has is removed, each key both
//   have is compared in turn, and each key only `to` has is added;
// - between two arrays: the items at the indexes both have are compared in
//   turn; then the items only `from` has are removed from the last one down,
//   or the items only `to` has are added in order;
// - any other difference replaces the value, the whole document when the
//   difference is at its root.

/** One operation of a JSON Patch. */
export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown };

/** The JSON Patch that turns one JSON value into another; empty when they are the same JSON. */
export function jsonPatch(from: unknown, to: unknown): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  diff(from, to, "", patch);
  return patch;
}

function diff(from: unknown, to: unknown, path: string, patch: JsonPatchOperation[]): void {
  if (sameJson(from, to)) return;
  if (isObject(from) && isObject(to)) {
    for (const key of Object.keys(from)) if (!Object.hasOwn(to, key)) patch.push({ op: "remove", path: `${path}/${escape(key)}` });
    for (const key of Object.keys(to)) {
      if (Object.hasOwn(from, key)) diff(from[key], to[key], `${path}/${escape(key)}`, patch);
    }
    for (const key of Object.keys(to)) if (!Object.hasOwn(from, key)) patch.push({ op: "add", path: `${path}/${escape(key)}`, value: to[key] });
    return;
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const shared = Math.min(from.length, to.length);
    for (let index = 0; index < shared; index += 1) diff(from[index], to[index], `${path}/${index}`, patch);
    for (let index = from.length - 1; index >= to.length; index -= 1) patch.push({ op: "remove", path: `${path}/${index}` });
    for (let index = from.length; index < to.length; index += 1) patch.push({ op: "add", path: `${path}/${index}`, value: to[index] });
    return;
  }
  patch.push({ op: "replace", path, value: to });
}

/** Whether two JSON values are the same, whatever the order of an object's keys. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return Object.is(a, b) || a === b;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A key as a JSON Pointer reference token (RFC 6901): ~ as ~0 and / as ~1. */
function escape(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
