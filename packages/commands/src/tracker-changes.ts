import { recordTrackerChange } from "@tiehall/catalog";
import { changeRequest, formatRequestKey, Refusal, requestTrackerChanged } from "@tiehall/core";
import { mirrors, teams, trackerChangeRecords, trackerMappings } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers, type HandlerContext } from "./execute.ts";
import { memberOf, teamsOfMember, type Member } from "./members.ts";
import { addSystemMessage } from "./messages.ts";
import { trackerChanges, type IssueState, type TrackerChange } from "./mirrors.ts";
import { createProposal } from "./proposals.ts";
import { lifecycleOf, lockRequestById } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";

// Changes read back from a tracker (tracker-mirrors: Mirror writes are
// idempotent and never echo; tracker-mirrors: Inbound tracker changes are
// recorded, not applied; tracker-mirrors: Tracker comments are not imported;
// tracker-mirrors: A tracker "Done" never closes a request by itself;
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
//
// A tracker "Done": a close the tracker does not mark as not planned (on
// GitHub, every close but one with the state_reason not_planned). It never
// moves the request to done. When its team's mapping has the setting for
// tracker "Done" proposals on, which is off until an admin turns it on, the
// mirror is the one in the tracker of the request's target team now, for
// its key there, not one a reassignment left behind, the
// close acts for a member of that team, mapped from the tracker account that
// closed the issue, and the request's state allows a move to done (claimed,
// in_progress or needs_info), the call creates a done proposal for that
// member, who confirms it in the web UI as any proposal: a commitment, so the
// command answers with the proposal. Otherwise, a tracker "Done" adds only a
// notice to the request's thread, in Tiehall's words, recorded as the
// system's, from the tracker. A close as not planned is recorded, and adds
// nothing else. A member who was removed since acts for nobody (execute()),
// so their close adds only the notice.

/** What Tiehall knows a mirror issue showed before it read anything back: open, as Tiehall made it, and assigned to nobody. */
const AS_MADE: IssueState = { open: true, closeReason: null, assignees: [] };

/** How a notice names each tracker. */
const TRACKER_NAMES: Readonly<Record<string, string>> = { github: "GitHub", jira: "Jira" };

function sameKnown(a: IssueState, b: IssueState): boolean {
  return (
    a.open === b.open &&
    a.closeReason === b.closeReason &&
    a.assignees.length === b.assignees.length &&
    a.assignees.every((account, index) => account.id === b.assignees[index]?.id && account.login === b.assignees[index]?.login)
  );
}

/** Whether a change is a tracker "Done": a close the tracker does not mark as not planned. */
function isTrackerDone(change: TrackerChange): boolean {
  return change.kind === "closed" && change.reason !== "not_planned";
}

/**
 * The member a tracker "Done" on this mirror becomes a done proposal for, if
 * any: the member the integration event acts for, read in the call's
 * transaction (execute()), when the mirror is in the tracker of the request's
 * target team, whose mapping has the setting on, the member belongs to that
 * team, and the request's state allows done.
 */
async function proposerOf(context: HandlerContext, request: RequestRow, mirror: { teamId: string; number: number | null }): Promise<Member | undefined> {
  const userId = context.caller.kind === "integration_event" ? context.caller.userId : undefined;
  // Only the mirror that follows the request now: one a reassignment left behind is not its target team's.
  if (userId === undefined || mirror.teamId !== request.targetTeamId || (mirror.number !== null && mirror.number !== request.number)) return undefined;
  const [mapping] = await context.tx
    .select({ doneProposals: trackerMappings.doneProposals })
    .from(trackerMappings)
    .where(and(eq(trackerMappings.orgId, context.orgId), eq(trackerMappings.teamId, request.targetTeamId)));
  if (mapping?.doneProposals !== true) return undefined;
  if (!(await teamsOfMember(context, userId)).some(({ id }) => id === request.targetTeamId)) return undefined;
  if (!changeRequest(await lifecycleOf(context, request), { kind: "done" }).ok) return undefined;
  return memberOf(context, userId);
}

export const TRACKER_CHANGE_HANDLERS: Handlers = {
  [recordTrackerChange.id]: defineHandler(recordTrackerChange, async ({ mirrorId, issue, by }, context) => {
    if (context.caller.kind !== "integration_event") throw new Refusal("forbidden", "Only a change read from a tracker is recorded as one.");
    const { tx, orgId } = context;
    const [found] = await tx.select({ requestId: mirrors.requestId }).from(mirrors).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    if (found === undefined) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const request = await lockRequestById(context, found.requestId);
    const [row] = await tx
      .select({ issue: mirrors.issue, teamId: mirrors.teamId, number: mirrors.number, tracker: mirrors.tracker, trackerState: mirrors.trackerState, expectedState: mirrors.expectedState })
      .from(mirrors)
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)))
      .for("update");
    if (row === undefined || row.issue === null) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const known = (row.trackerState as IssueState | null) ?? AS_MADE;
    const now: IssueState = { open: issue.open, closeReason: issue.open ? null : issue.closeReason, assignees: issue.assignees };
    const changes: TrackerChange[] = trackerChanges(known, row.expectedState as Pick<IssueState, "open" | "closeReason"> | null, now);
    const done = changes.some(isTrackerDone);
    const proposer = done ? await proposerOf(context, request, row) : undefined;
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
        if (done && proposer === undefined) {
          const [team] = await writer.tx.select({ key: teams.key }).from(teams).where(and(eq(teams.orgId, writer.orgId), eq(teams.id, request.targetTeamId)));
          const key = formatRequestKey(team?.key ?? "", request.number);
          const tracker = TRACKER_NAMES[row.tracker] ?? row.tracker;
          await addSystemMessage(
            writer,
            request.id,
            `The ${tracker} mirror issue of ${key} was closed. A close in ${tracker} does not change the request: ${key} is still ${request.state}.`,
            { actorKind: "system", surface: "github" },
          );
        }
      });
    }
    if (!sameKnown(known, now)) await tx.update(mirrors).set({ trackerState: now }).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    // A tracker "Done" by a member of the target team, with the setting on: a done proposal for them, which they
    // confirm in the web UI, made as the integration event acting for them.
    if (proposer !== undefined) return createProposal({ ...context, member: proposer }, request, { kind: "done", change: {} });
    return { changes: changes.map(({ kind }) => kind) };
  }),
};
