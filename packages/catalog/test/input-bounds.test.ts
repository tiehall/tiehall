import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, overlongArrays } from "../src/index.ts";

// Arrays longer than their schemas allow (public-api: Input and output follow
// the published schemas; public-api: Request bodies have a size limit). zod
// judges every element of an array before it checks the array's length, so
// execute() first asks where an input holds an array longer than its schema
// allows, which needs no element of such an array judged, and refuses it with
// the issue zod itself gives for the array's length.

/** A schema whose elements count the times zod judged one. */
function counted(): { element: z.ZodType; judged: () => number } {
  let judged = 0;
  const element = z.unknown().refine(() => {
    judged += 1;
    return true;
  });
  return { element, judged: () => judged };
}

describe("overlongArrays", () => {
  it("finds an array longer than its maximum, with zod's own issue for it, and judges none of its elements", () => {
    const { element, judged } = counted();
    const schema = z.object({ items: z.array(element).max(3) });

    expect(overlongArrays(schema, { items: [1, 2, 3, 4] })).toEqual([{ path: ["items"], message: "Too big: expected array to have <=3 items" }]);
    expect(judged()).toBe(0);
    expect(schema.safeParse({ items: [1, 2, 3, 4] }).error?.issues.find(({ path }) => path.join() === "items")?.message).toBe(
      "Too big: expected array to have <=3 items",
    );
  });

  it("keeps an array's own message for its maximum, and an exact length", () => {
    expect(overlongArrays(z.object({ items: z.array(z.string()).max(1, "One item at most.") }), { items: ["a", "b"] })).toEqual([
      { path: ["items"], message: "One item at most." },
    ]);
    expect(overlongArrays(z.object({ pair: z.array(z.string()).length(2) }), { pair: ["a", "b", "c"] })).toEqual([
      { path: ["pair"], message: expect.any(String) },
    ]);
  });

  it("finds nothing in an array within its maximum, or one with none, or input of another type, which zod judges", () => {
    const schema = z.object({ items: z.array(z.string()).max(3), free: z.array(z.string()) });
    expect(overlongArrays(schema, { items: ["a", "b", "c"], free: Array.from({ length: 10_000 }, () => "x") })).toEqual([]);
    expect(overlongArrays(schema, { items: "not a list" })).toEqual([]);
    expect(overlongArrays(schema, undefined)).toEqual([]);
    expect(overlongArrays(schema, [1, 2, 3, 4, 5])).toEqual([]);
  });

  it("looks through optional, nullable and default fields, nested objects, records and arrays, and the variant an input names", () => {
    const leaf = z.array(z.number()).max(1);
    const schema = z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("deep"),
        outer: z.object({ inner: leaf.optional() }).nullable(),
        rows: z.array(z.object({ cells: leaf })).max(5),
        byName: z.record(z.string(), leaf),
        withDefault: leaf.default([]),
      }),
      z.strictObject({ kind: z.literal("flat"), rows: z.array(z.number()).max(100) }),
    ]);

    expect(
      overlongArrays(schema, {
        kind: "deep",
        outer: { inner: [1, 2] },
        rows: [{ cells: [1] }, { cells: [1, 2] }],
        byName: { a: [1], b: [1, 2] },
        withDefault: [1, 2],
      }).map(({ path }) => path),
    ).toEqual([["outer", "inner"], ["rows", 1, "cells"], ["byName", "b"], ["withDefault"]]);
    // The other variant allows more rows.
    expect(overlongArrays(schema, { kind: "flat", rows: [1, 2, 3, 4, 5, 6] })).toEqual([]);
  });

  it("names at most as many arrays as asked", () => {
    const schema = z.array(z.array(z.number()).max(1)).max(1000);
    expect(overlongArrays(schema, Array.from({ length: 1000 }, () => [1, 2]), 100)).toHaveLength(100);
  });

  it("refuses contract.report's changes beyond the 1000 a report holds, before any change is judged", () => {
    const input = CATALOG.get("contract.report")?.input;
    expect(input).toBeDefined();
    expect(overlongArrays(input as z.ZodType, { changes: Array.from({ length: 1001 }, () => ({})) })).toEqual([
      { path: ["changes"], message: "Too big: expected array to have <=1000 items" },
    ]);
  });
});
