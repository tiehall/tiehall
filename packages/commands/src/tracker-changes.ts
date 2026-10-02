import { recordTrackerChange } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { mirrors } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { trackerChanges, type IssueState } from "./mirrors.ts";

// Changes read back from a tracker (tracker-mirrors: Mirror writes are
// idempotent and never echo; tracker-mirrors: Inbound tracker changes are
// recorded, not applied; design.md, Technical decisions: T16). The
// processing of a tracker's change, such as a GitHub `issues` delivery
// (github-issue-processing.ts), reads the mirror issue from the tracker and
// runs mirrors.record_tracker_change with what it shows now, as the
// integration event. Only such an event may run it: it is an internal
// command, and a web session or a job that is not the tracker's own gets 403.
// The handler compares the read with what Tiehall knows the issue shows,
// from its own writes and the changes it read before, and with what a write
// of its own under way will leave it showing (mirrors.ts, trackerChanges()):
// a read that shows either is an echo of Tiehall's own write, or nothing new,
// and is dropped. What Tiehall knows of the issue then follows the read, in
// the call's transaction, with the mirror's row locked, so two reads of one
// issue are compared one after the other.

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
  [recordTrackerChange.id]: defineHandler(recordTrackerChange, async ({ mirrorId, issue }, context) => {
    if (context.caller.kind !== "integration_event") throw new Refusal("forbidden", "Only a change read from a tracker is recorded as one.");
    const { tx, orgId } = context;
    const [row] = await tx
      .select({ issue: mirrors.issue, trackerState: mirrors.trackerState, expectedState: mirrors.expectedState })
      .from(mirrors)
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)))
      .for("update");
    if (row === undefined || row.issue === null) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const known = (row.trackerState as IssueState | null) ?? AS_MADE;
    const now: IssueState = { open: issue.open, closeReason: issue.open ? null : issue.closeReason, assignees: issue.assignees };
    const changes = trackerChanges(known, row.expectedState as Pick<IssueState, "open" | "closeReason"> | null, now);
    if (!sameKnown(known, now)) await tx.update(mirrors).set({ trackerState: now }).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    return { changes: changes.map(({ kind }) => kind) };
  }),
};
