import { describe, expect, it } from "vitest";
import { nextUtcDay, secondsUntil, WRITE_LIMITS } from "../src/write-limits.ts";

// The numbers and time arithmetic of the limits on agent writes (agent-safety:
// Agent writes are limited per token and budgeted per install).

describe("the limits on agent writes", () => {
  it("name their numbers", () => {
    expect(WRITE_LIMITS).toEqual({
      tokenWritesPerWindow: 60,
      tokenWindowMs: 60_000,
      defaultDailyWriteBudget: 5_000,
      minDailyWriteBudget: 1,
      maxDailyWriteBudget: 1_000_000,
      openedPerUserPerWindow: 20,
      openedWindowMs: 3_600_000,
      openedPerTeamPairPerDay: 50,
    });
  });

  it("wait whole seconds, at least one, and until the next UTC day", () => {
    expect(secondsUntil(new Date("2026-10-01T09:00:59.500Z"), new Date("2026-10-01T09:01:00Z"))).toBe(1);
    expect(secondsUntil(new Date("2026-10-01T09:00:00Z"), new Date("2026-10-01T09:00:00Z"))).toBe(1);
    expect(secondsUntil(new Date("2026-10-01T09:00:00Z"), new Date("2026-10-01T09:00:02.001Z"))).toBe(3);
    expect(nextUtcDay(new Date("2026-10-01T09:00:00Z")).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(nextUtcDay(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
