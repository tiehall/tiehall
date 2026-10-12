import { mirrorFailures, mirrors, requests, trackerMappings } from "@tiehall/db";
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
// or whose target team maps a tracker and that its mapping may mirror now:
// once claimed, or from its opening when the team mirrors on open. The job
// then decides, by whether the request reached that point after the mapping
// was made, and writes only to issues whose mapping holds (mirrors.ts).
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
// dead-letter queue is shown with a Retry button (mirror-failures.ts). It does
// not hold back the request's later jobs (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (76); Technical decisions:
// T10): the write that sends a newer job takes the failed one out of the
// queue, so the newer job runs under the request's key, still one at a time,
// and does all the failed one would have done, the comments it missed
// included, since jobs project the request as it is when they run. The same
// write records the failed job for its banner, which the worker may not have
// done yet, and the banner stays until a job of the request succeeds. A newer
// job sent while the failed one was still tried waits behind it until its
// attempts are used up: the worker, once it reaches the failed job's dead
// letter, takes it out of the queue as it records it (mirrors.ts), so the
// newer job runs then; with no newer job waiting, the failed job stays, for
// Retry, until the request's next change.

/** A mirror job: bring the request's mirror issue up to date with the request as it is now. */
export const mirrorRequest = defineJobType<{ requestId: string }>("mirror.sync", 1, {
  retryLimit: 4,
  retryDelaySeconds: 14 * 60,
  retryBackoff: false,
  expireInSeconds: 120,
  policy: "key_strict_fifo",
});

/** The events whose change can change what a request's mirror issue shows, such as its provider change shipping (contract-changes: Merging the provider PR marks the change shipped). */
const MIRRORED_EVENTS: ReadonlySet<string> = new Set([
  "request.opened",
  "request.claimed",
  "request.started",
  "request.released",
  "request.state_changed",
  "request.reassigned",
  "request.provider_change_shipped",
]);

/** Whether an event can change what its request's mirror issue shows: a change of the request, such as of its state, or a question on it. */
export function changesMirror(type: string, data: Readonly<Record<string, unknown>>): boolean {
  if (typeof data["requestId"] !== "string") return false;
  if (type === "request.message_posted") return data["kind"] === "question";
  return MIRRORED_EVENTS.has(type);
}

/**
 * Sends the request's mirror job in the write's transaction, when the request
 * has a mirror issue, or its target team maps a tracker and its mapping may
 * mirror the request now, taking out of the queue a failed job of the request
 * that would hold it back; sends nothing otherwise.
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
  // A failed job of the request would hold this one back: it leaves the queue, and its banner stays until a job succeeds.
  const failed = await jobs.dropFailed?.(tx, mirrorRequest.queue, requestId);
  if (failed !== undefined) await tx.insert(mirrorFailures).values({ orgId, requestId, failedAt: failed.failedAt }).onConflictDoNothing();
  await jobs.send(tx, mirrorRequest.queue, { requestId }, { singletonKey: requestId });
}
