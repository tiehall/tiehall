import { describe, expect, it } from "vitest";
import { undoOf, undoUntil, type CommitmentKind, type TakenEffect } from "../src/index.ts";

// Who may undo a commitment, and until when (requests: The undo window for
// reversible commitments; design.md, Decisions this change rests on: D28 #34,
// D30 (4)). Only a due date, a scope change, a reassignment and a decline can
// be undone, for 15 minutes from when they took effect, once, by a person who
// confirmed them: either of the two for a commitment each side confirmed.

const ALICE = "a1a1a1a1-0000-4000-8000-000000000001";
const BOB = "b1b1b1b1-0000-4000-8000-000000000002";
const ERIN = "e1e1e1e1-0000-4000-8000-000000000003";
const APPLIED = new Date("2026-10-01T10:00:00Z");

function taken(kind: CommitmentKind, options: { undone?: boolean; confirmedBy?: string[] } = {}): TakenEffect {
  return { kind, appliedAt: APPLIED, undone: options.undone ?? false, confirmedBy: options.confirmedBy ?? [ALICE, BOB] };
}

const outcome = (verdict: ReturnType<typeof undoOf>) => (verdict.ok ? "ok" : verdict.refusal);

describe("undoing a commitment", () => {
  it.each([
    ["the accountable human, 10 minutes after", taken("due_date"), ALICE, "2026-10-01T10:10:00Z", "ok"],
    ["the other side, alone", taken("due_date"), BOB, "2026-10-01T10:10:00Z", "ok"],
    ["exactly at 15 minutes", taken("decline", { confirmedBy: [ERIN] }), ERIN, "2026-10-01T10:15:00Z", "ok"],
    ["16 minutes after", taken("decline", { confirmedBy: [ERIN] }), ERIN, "2026-10-01T10:16:00Z", "conflict"],
    ["someone who did not confirm it", taken("decline", { confirmedBy: [ERIN] }), BOB, "2026-10-01T10:05:00Z", "forbidden"],
    ["a scope change", taken("scope"), BOB, "2026-10-01T10:05:00Z", "ok"],
    ["a reassignment", taken("reassign", { confirmedBy: [BOB] }), BOB, "2026-10-01T10:05:00Z", "ok"],
    ["a withdrawal, which has no undo", taken("withdraw", { confirmedBy: [ALICE] }), ALICE, "2026-10-01T10:05:00Z", "conflict"],
    ["a done, which has no undo", taken("done", { confirmedBy: [BOB] }), BOB, "2026-10-01T10:05:00Z", "conflict"],
    ["one undone already", taken("decline", { undone: true, confirmedBy: [ERIN] }), ERIN, "2026-10-01T10:05:00Z", "conflict"],
  ] as const)("by %s", (_name, commitment, actor, now, expected) => {
    expect(outcome(undoOf(commitment, actor, new Date(now)))).toBe(expected);
  });

  it("is offered until 15 minutes after the commitment took effect, and only for the four that can be undone", () => {
    expect(undoUntil(taken("decline"))?.toISOString()).toBe("2026-10-01T10:15:00.000Z");
    expect(undoUntil(taken("withdraw"))).toBeUndefined();
    expect(undoUntil(taken("done"))).toBeUndefined();
    expect(undoUntil(taken("due_date", { undone: true }))).toBeUndefined();
  });
});
