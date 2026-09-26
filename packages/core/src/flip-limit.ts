// The flip limit (agent-safety: A request flips between needs_info and
// in_progress at most 3 times a day; design.md, Decisions this change rests
// on: D28 #51; design.md, Readings to confirm with the founder: R15). A pure
// rule. A flip is a round trip from in_progress to needs_info and back. It is
// counted when the blocking question that starts it was posted by an agent,
// whoever answers it, and it counts on the UTC day that question was posted.
// A blocking question posted from a web session starts no counted flip, and
// one on a request that is open or claimed, or already waits in needs_info,
// starts no flip at all. An agent's blocking question that would start a
// fourth counted flip on the same UTC day is posted as non-blocking.

/** How many counted flips a request may make per UTC day. */
export const FLIPS_PER_DAY = 3;

/** The UTC day of a time, such as 2026-10-01. */
export function utcDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/** Whether a question starts a counted flip: an agent's blocking question on a request that is in_progress. */
export function startsCountedFlip(question: { actorKind: string; blocking: boolean; state: string }): boolean {
  return question.blocking && question.actorKind === "agent" && question.state === "in_progress";
}
