import { describe, expect, it } from "vitest";
import { FLIPS_PER_DAY, startsCountedFlip, utcDay } from "../src/flip-limit.ts";

// The flip limit as a pure rule (agent-safety: A request flips between
// needs_info and in_progress at most 3 times a day).

describe("the flip limit", () => {
  it("counts only an agent's blocking question on a request that is in_progress", () => {
    expect(startsCountedFlip({ actorKind: "agent", blocking: true, state: "in_progress" })).toBe(true);
    for (const question of [
      { actorKind: "web_session", blocking: true, state: "in_progress" },
      { actorKind: "agent", blocking: false, state: "in_progress" },
      { actorKind: "agent", blocking: true, state: "claimed" },
      { actorKind: "agent", blocking: true, state: "open" },
      { actorKind: "agent", blocking: true, state: "needs_info" },
    ]) {
      expect(startsCountedFlip(question), JSON.stringify(question)).toBe(false);
    }
  });

  it("counts by UTC day, 3 a day", () => {
    expect(utcDay(new Date("2026-10-01T23:59:59Z"))).toBe("2026-10-01");
    expect(utcDay(new Date("2026-10-02T00:00:00+02:00"))).toBe("2026-10-01");
    expect(FLIPS_PER_DAY).toBe(3);
  });
});
