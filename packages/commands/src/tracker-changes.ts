import { recordTrackerChange } from "@tiehall/catalog";
import { Refusal, requestTrackerChanged } from "@tiehall/core";
import { mirrors, trackerChangeRecords } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { trackerChanges, type IssueState, type TrackerChange } from "./mirrors.ts";
import { lockRequestById } from "./request-changes.ts";

// Changes read back from a tracker (tracker-mirrors: Mirror writes are
// idempotent and never echo; tracker-mirrors: Inbound tracker changes are
// recorded, not applied; tracker-mirrors: Tracker comments are not imported;
// design.md, Design rules: Tracker mirrors; design.md, Technical decisions:
// T16). The processing of a tracker's change, such as a GitHub `issues`
// delivery (github-issue-processing.ts), reads the mirror issue from the
// tracker and runs mirrors.record_tracker_change with what it shows now, as
// the integration event, acting for the member whose tracker account made
// the change. Only such an event may run it: it is an internal command, and a
// web session or a job that is not the tracker's own gets 403.
//
// The handler compares the read with what Tiehall knows the issue shows,
// from its own writes and the changes it read before, and with what a write
// of its own under way will leave it showing (mirrors.ts, trackerChanges()):
// a read that shows either is an echo of Tiehall's own write, or nothing new,
// and is dropped. Each change it shows besides, a close, a reopen or new
// assignees, is recorded on the request: Tiehall's record of it, which holds
// the tracker accounts it was about, and the domain event
// request.tracker_changed that names it, with the caller's provenance, the
// actor kind integration and the tracker as the surface. Nothing else of the
// request changes: not its state, nor its claim, title or thread. Edits of
// the issue's title or body, and its comments, are none of these changes, so
// they record nothing. What Tiehall knows of the issue then follows the read.
// The request's row is locked first, then the mirror's (event-sequence.ts),
// so two reads of one issue are compared one after the other, and a change
// that a webhook delivery and a later read both show is recorded once.

/** What Tiehall knows a mirror issue showed before it read anything back: open, as Tiehall made it, and assigned to nobody. */
const AS_MADE: IssueState = { open: true, closeReason: null, assignees: [] };

function sameKnown(a: IssueState, b: IssueState): boolean {
  return (
    a.open === b.open &&
    a.closeReason === b.closeReason &&
    a.assignees.length === b.assignees.length &&
    a.assignees.every((account, index) => account.id === b.assignees[index]?.id && account.login === b.assignees[index]?.login)
  );
}

export const TRACKER_CHANGE_HANDLERS: Handlers = {
  [recordTrackerChange.id]: defineHandler(recordTrackerChange, async ({ mirrorId, issue, by }, context) => {
    if (context.caller.kind !== "integration_event") throw new Refusal("forbidden", "Only a change read from a tracker is recorded as one.");
    const { tx, orgId } = context;
    const [found] = await tx.select({ requestId: mirrors.requestId }).from(mirrors).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    if (found === undefined) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const request = await lockRequestById(context, found.requestId);
    const [row] = await tx
      .select({ issue: mirrors.issue, trackerState: mirrors.trackerState, expectedState: mirrors.expectedState })
      .from(mirrors)
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)))
      .for("update");
    if (row === undefined || row.issue === null) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const known = (row.trackerState as IssueState | null) ?? AS_MADE;
    const now: IssueState = { open: issue.open, closeReason: issue.open ? null : issue.closeReason, assignees: issue.assignees };
    const changes: TrackerChange[] = trackerChanges(known, row.expectedState as Pick<IssueState, "open" | "closeReason"> | null, now);
    if (changes.length > 0) {
      await context.write(async (writer) => {
        await writer.changesRequest(request.id);
        for (const change of changes) {
          const [record] = await writer.tx
            .insert(trackerChangeRecords)
            .values({
              orgId: writer.orgId,
              mirrorId,
              requestId: request.id,
              change: change.kind,
              reason: change.kind === "closed" ? change.reason : null,
              actor: by,
              assignees: change.kind === "assignees_changed" ? change.assignees : null,
            })
            .returning({ id: trackerChangeRecords.id });
          if (record === undefined) throw new Error("The record of the tracker's change was not returned.");
          await writer.record(requestTrackerChanged, {
            requestId: request.id,
            mirrorId,
            trackerChangeId: record.id,
            change: change.kind,
            ...(change.kind === "closed" ? { reason: change.reason } : {}),
          });
        }
      });
    }
    if (!sameKnown(known, now)) await tx.update(mirrors).set({ trackerState: now }).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    return { changes: changes.map(({ kind }) => kind) };
  }),
};
