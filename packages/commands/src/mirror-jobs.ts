import { mirrors, requests, trackerMappings } from "@tiehall/db";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { defineJobType, type JobSender } from "./jobs.ts";
import type { OrgContext } from "./with-org.ts";

// The mirror job and what sends it (tracker-mirrors: A mirror is a
// projection of the request; tracker-mirrors: Mirror writes are idempotent
// and never echo; design.md, Technical decisions: T5, T6 and T16). A mirror
// job brings a request's mirror issue up to date with the request as it is
// when the job runs (mirrors.ts), so it carries nothing but the request's id.
// The write path sends one in the transaction of each write that records an
// event that can change what a mirror shows, such as a claim or a state
// change, so the job commits with the change, or not at all; it sends at most
// one per request and write, and only for a request that has a mirror issue,
// or whose target team maps a tracker and that its mapping would mirror now:
// once claimed, or from its opening when the team mirrors on open.
//
// The jobs of one request run one at a time, in the order of the writes that
// sent them, never two at once (the queue's key_strict_fifo policy, keyed by
// the request's id), so two jobs never write the same mirror issue together,
// and every mirror of the request is a mirror of that one key. Other
// requests' jobs run beside them. A failing job is tried 5 times over about
// an hour, then moves to the dead-letter queue (tracker-mirrors: Failed
// mirror jobs are shown with a Retry button; design.md, Decisions this change
// rests on: D28 #83): each next attempt comes a fixed 14 minutes after the
// one before failed, with no backoff, whose random spread would carry the
// fifth attempt past the hour, and an attempt counts as failed after 2
// minutes at the most. So the fifth attempt comes 56 minutes after the first
// when each attempt fails at once, and 64 when each runs until it expires:
// between 50 and 70 minutes after the first, as the rule wants. A job in the
// dead-letter queue is shown with a Retry button (mirror-failures.ts), and
// holds back the request's later jobs until it runs again.

/** A mirror job: bring the request's mirror issue up to date with the request as it is now. */
export const mirrorRequest = defineJobType<{ requestId: string }>("mirror.sync", 1, {
  retryLimit: 4,
  retryDelaySeconds: 14 * 60,
  retryBackoff: false,
  expireInSeconds: 120,
  policy: "key_strict_fifo",
});

/** The events whose change can change what a request's mirror issue shows. */
const MIRRORED_EVENTS: ReadonlySet<string> = new Set([
  "request.opened",
  "request.claimed",
  "request.started",
  "request.released",
  "request.state_changed",
  "request.reassigned",
]);

/** Whether an event can change what its request's mirror issue shows: a change of the request, such as of its state, or a question on it. */
export function changesMirror(type: string, data: Readonly<Record<string, unknown>>): boolean {
  if (typeof data["requestId"] !== "string") return false;
  if (type === "request.message_posted") return data["kind"] === "question";
  return MIRRORED_EVENTS.has(type);
}

/**
 * Sends the request's mirror job in the write's transaction, when the request
 * has a mirror issue, or its target team maps a tracker and its mapping
 * mirrors the request now; sends nothing otherwise.
 */
export async function wakeMirror({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, jobs: JobSender, requestId: string): Promise<void> {
  const [mirrored] = await tx
    .select({ requestId: mirrors.requestId })
    .from(mirrors)
    .where(and(eq(mirrors.orgId, orgId), eq(mirrors.requestId, requestId)))
    .limit(1);
  if (mirrored === undefined) {
    const [mapped] = await tx
      .select({ id: requests.id })
      .from(requests)
      .innerJoin(trackerMappings, and(eq(trackerMappings.orgId, requests.orgId), eq(trackerMappings.teamId, requests.targetTeamId)))
      .where(
        and(
          eq(requests.orgId, orgId),
          eq(requests.id, requestId),
          or(eq(trackerMappings.mirrorOnOpen, true), isNotNull(requests.claimedAt), isNotNull(requests.claimantUserId)),
        ),
      );
    if (mapped === undefined) return;
  }
  await jobs.send(tx, mirrorRequest.queue, { requestId }, { singletonKey: requestId });
}
