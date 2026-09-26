import { describe, expect, it } from "vitest";
import { LOOP_LIMIT, recordAgentWrite } from "../src/loop-limit.ts";

// The loop limit as a pure rule (agent-safety: Runaway agent loops flag the
// request needs_human; design.md, Decisions this change rests on: D28 #50,
// D30 (1), (4)). Given the times of the agent writes on a request since the
// last human action and the time of a new one, it says whether the new write
// flags the request: when it makes 7 within 10 minutes, or 30 in total.

const t = (time: string) => new Date(`2026-10-01T${time}Z`);
const series = (start: string, count: number, stepSeconds: number) =>
  Array.from({ length: count }, (_, index) => new Date(t(start).getTime() + index * stepSeconds * 1000));

describe("recordAgentWrite", () => {
  it("keeps the new write's time after the earlier ones", () => {
    expect(recordAgentWrite([t("09:00:00")], t("09:01:00"))).toEqual({ writes: [t("09:00:00"), t("09:01:00")], flags: false });
  });

  it("flags with the write that makes 7 within 10 minutes, the first of them included at exactly 10 minutes", () => {
    expect(recordAgentWrite(series("09:00:00", 6, 40), t("09:04:00")).flags).toBe(true);
    expect(recordAgentWrite([t("09:00:00"), ...series("09:05:00", 5, 0)], t("09:10:00")).flags).toBe(true);
    expect(recordAgentWrite([t("09:00:00"), ...series("09:05:00", 5, 0)], t("09:10:00.001")).flags).toBe(false);
  });

  it("does not flag 6 within 10 minutes and a seventh at 09:12", () => {
    expect(recordAgentWrite(series("09:00:00", 6, 60), t("09:12:00")).flags).toBe(false);
  });

  it("flags with the thirtieth write in total, however slow", () => {
    expect(recordAgentWrite(series("09:00:00", 28, 600), t("13:40:00")).flags).toBe(false);
    expect(recordAgentWrite(series("09:00:00", 29, 600), t("13:50:00")).flags).toBe(true);
  });

  it("names its numbers", () => {
    expect(LOOP_LIMIT).toEqual({ windowMs: 600_000, writesInWindow: 7, writesInTotal: 30 });
  });
});
