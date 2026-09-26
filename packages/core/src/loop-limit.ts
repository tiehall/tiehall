// The loop limit (agent-safety: Runaway agent loops flag the request
// needs_human; design.md, Decisions this change rests on: D28 #50, D30 (1),
// (4); design.md, Technical decisions: T14). A pure rule. Tiehall keeps, for
// each request, the times of the agent writes on it since the last human
// action. A new agent write flags the request needs_human when it makes 7
// writes within 10 minutes, the first of them at most 10 minutes before it, or
// 30 in total; that write is accepted. Once a request is flagged, agent writes
// to it are refused and not counted, and a human action clears the flag and
// the times, so the limit aims at runaway loops and not at an ordinary
// exchange of questions and answers, which stays under both counts.

export const LOOP_LIMIT = {
  /** The window of the fast count. */
  windowMs: 10 * 60 * 1000,
  /** The agent write that makes this many within the window flags the request. */
  writesInWindow: 7,
  /** The agent write that makes this many since the last human action flags the request. */
  writesInTotal: 30,
} as const;

/** The times of the agent writes after a new one, and whether the new one flags the request. */
export function recordAgentWrite(previous: readonly Date[], now: Date): { writes: Date[]; flags: boolean } {
  const writes = [...previous, now];
  const inWindow = writes.filter((time) => now.getTime() - time.getTime() <= LOOP_LIMIT.windowMs).length;
  return { writes, flags: inWindow >= LOOP_LIMIT.writesInWindow || writes.length >= LOOP_LIMIT.writesInTotal };
}
