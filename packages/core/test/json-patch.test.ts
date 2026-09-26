import fc from "fast-check";
import jsonPatchLibrary from "fast-json-patch";
import { describe, expect, it } from "vitest";
import { jsonPatch, type JsonPatchOperation } from "../src/json-patch.ts";

// What changed since revision N, as an RFC 6902 JSON Patch (handoff-packet:
// What changed since revision N; design.md, Decisions this change rests on:
// D28 #25). jsonPatch(from, to) gives the operations that turn one JSON value
// into another. The property tests apply them with an independent RFC 6902
// implementation, so the patch is checked against the RFC and not against
// this module's own reading of it.

/** A copy of a JSON value. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Applies a patch as RFC 6902 says, with fast-json-patch, to a copy of the document. */
function apply(document: unknown, patch: readonly JsonPatchOperation[]): unknown {
  return jsonPatchLibrary.applyPatch(copy(document), copy(patch) as never, true, false).newDocument;
}

/** JSON values of the kinds a packet holds, with keys that need escaping in a JSON Pointer. */
const key = fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom("a/b", "~", "~1", "", "untrusted", "need", "0"));
const value = fc.letrec((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
    fc.string({ maxLength: 8 }),
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(key, tie("json"), { maxKeys: 4 }),
  ),
})).json;

/** A packet, and a version of it with some fields changed, removed or added. */
const packetPair = fc
  .record({
    need: fc.string({ minLength: 1, maxLength: 20 }),
    acceptance_criteria: fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }),
    links: fc.array(fc.record({ url: fc.webUrl(), title: fc.string({ maxLength: 8 }) }, { requiredKeys: ["url"] }), { maxLength: 3 }),
    extensions: fc.dictionary(fc.constantFrom("com.acme.a", "com.acme.b", "io.example.c"), value, { maxKeys: 3 }),
  })
  .chain((untrusted) =>
    fc.tuple(
      fc.constant({ schema_version: "1-beta", kind: "request", untrusted }),
      fc.record(
        {
          need: fc.oneof(fc.constant(untrusted.need), fc.string({ minLength: 1, maxLength: 20 })),
          acceptance_criteria: fc.oneof(fc.constant(untrusted.acceptance_criteria), fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 })),
          links: fc.oneof(fc.constant(untrusted.links), fc.array(fc.record({ url: fc.webUrl() }), { maxLength: 3 })),
          extensions: fc.oneof(fc.constant(untrusted.extensions), fc.dictionary(fc.constantFrom("com.acme.a", "com.acme.b"), value, { maxKeys: 3 })),
        },
        { requiredKeys: ["need"] },
      ),
      fc.option(fc.constantFrom("2026-10-15", "2026-11-01"), { nil: undefined }),
    ),
  )
  .map(([from, changed, due]) => [from, { schema_version: "1-beta", kind: "request", ...(due === undefined ? {} : { due_date: due }), untrusted: changed }] as const);

describe("a JSON Patch between two values", () => {
  it("turns any JSON value into any other when applied as RFC 6902 says", () => {
    fc.assert(
      fc.property(value, value, (from, to) => {
        expect(apply(from, jsonPatch(from, to))).toEqual(to);
      }),
      { numRuns: 500 },
    );
  });

  it("turns a packet into a later revision of it", () => {
    fc.assert(
      fc.property(packetPair, ([from, to]) => {
        expect(apply(from, jsonPatch(from, to))).toEqual(to);
      }),
      { numRuns: 300 },
    );
  });

  it("is empty between a value and itself, whatever the order of its keys", () => {
    fc.assert(
      fc.property(value, (document) => {
        expect(jsonPatch(document, copy(document))).toEqual([]);
      }),
    );
    expect(jsonPatch({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual([]);
  });

  it("uses add, remove and replace, with keys escaped in the path", () => {
    expect(jsonPatch({ untrusted: { need: "a", "a/b": 1, "~": 2 } }, { untrusted: { need: "b", links: [] } })).toEqual([
      { op: "remove", path: "/untrusted/a~1b" },
      { op: "remove", path: "/untrusted/~0" },
      { op: "replace", path: "/untrusted/need", value: "b" },
      { op: "add", path: "/untrusted/links", value: [] },
    ]);
    expect(jsonPatch([1, 2, 3], [1])).toEqual([
      { op: "remove", path: "/2" },
      { op: "remove", path: "/1" },
    ]);
    expect(jsonPatch([1], [1, 2, 3])).toEqual([
      { op: "add", path: "/1", value: 2 },
      { op: "add", path: "/2", value: 3 },
    ]);
    expect(jsonPatch({ a: 1 }, [1])).toEqual([{ op: "replace", path: "", value: [1] }]);
  });
});
