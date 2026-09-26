import { describe, expect, it } from "vitest";
import { formatRequestKey, parseRequestKey, REQUEST_NUMBER_MAX } from "../src/index.ts";

// Request keys (requests: Per-team request keys; teams-and-roles: Team keys;
// design.md, Self-hosting decisions: S15). A request's key is its team's key,
// a hyphen and its number in the team's count, such as FE-142.

describe("a request key", () => {
  it.each([
    ["FE-142", { teamKey: "FE", number: 142 }],
    ["PAY2-1", { teamKey: "PAY2", number: 1 }],
    ["PLATFORM10-2147483647", { teamKey: "PLATFORM10", number: 2147483647 }],
  ])("reads %s", (key, parsed) => {
    expect(parseRequestKey(key)).toEqual(parsed);
    expect(formatRequestKey(parsed.teamKey, parsed.number)).toBe(key);
  });

  it.each(["fe-142", "FE142", "FE-", "FE-0", "FE-042", "F-1", "FE-1.5", "FE--1", " FE-1", "FE-1 ", "FE-2147483648", "FE-99999999999"])(
    "is not %j",
    (key) => {
      expect(parseRequestKey(key)).toBeUndefined();
    },
  );

  it("holds a number up to what the database's count holds", () => {
    expect(REQUEST_NUMBER_MAX).toBe(2 ** 31 - 1);
  });
});
