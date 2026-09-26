// The limits on agent writes (agent-safety: Agent writes are limited per token
// and budgeted per install; agent-safety: Agent-opened requests are capped;
// design.md, Decisions this change rests on: D28 #49; design.md, Readings to
// confirm with the founder: R15). Pure numbers and time arithmetic: one token
// makes at most 60 writes within any 60 seconds; the install's agents make at
// most the daily write budget of writes per UTC day, 5,000 unless an admin
// changes it, to between 1 and 1,000,000.

export const WRITE_LIMITS = {
  /** The most writes one token makes within any window of this many milliseconds. */
  tokenWritesPerWindow: 60,
  tokenWindowMs: 60_000,
  /** The install's daily write budget until an admin changes it. */
  defaultDailyWriteBudget: 5_000,
  /** The budgets an admin may set. */
  minDailyWriteBudget: 1,
  maxDailyWriteBudget: 1_000_000,
} as const;

/** How many whole seconds, at least 1, until a time. */
export function secondsUntil(now: Date, then: Date): number {
  return Math.max(1, Math.ceil((then.getTime() - now.getTime()) / 1000));
}

/** The start of the next UTC day after a time. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
