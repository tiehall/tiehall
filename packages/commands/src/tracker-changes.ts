import { recordTrackerChange } from "@tiehall/catalog";
import { changeRequest, formatRequestKey, Refusal, requestTrackerChanged } from "@tiehall/core";
import { mirrors, teams, trackerChangeRecords, trackerMappings } from "@tiehall/db";
import { and, eq, inArray } from "drizzle-orm";
import { defineHandler, type Handlers, type HandlerContext } from "./execute.ts";
import { memberOf, teamsOfMember, type Member } from "./members.ts";
import { addSystemMessage } from "./messages.ts";
import { madeBy, trackerChanges, type IssueState, type TrackerChange } from "./mirrors.ts";
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
// the change; when the tracker names different accounts for the issue's
// state and for its assignees, it runs it once for each part, acting for the
// account that made that part. Only such an event may run it: it is an
// internal command, and a web session or a job that is not the tracker's own
// gets 403.
//
// The handler compares the read with what Tiehall knows the issue shows,
// from its own writes and the changes it read before, and with what a write
// of its own under way will leave it showing (mirrors.ts, trackerChanges()):
// a read that shows either is an echo of Tiehall's own write, or nothing new,
// and is dropped; but a close or reopen the tracker says another account
// made, such as a person's close of an open issue, is no echo, even when it
// matches a write Tiehall began and the tracker never applied. A change of the
// close reason alone is not told apart that way: GitHub keeps naming whoever
// closed the issue as its closer when Tiehall changes only the reason, as it
// does when it closes, for the request's end, an issue a person closed with
// another reason. A read taken before a write of the issue's state began or
// ended, and recorded after, may show the issue as it was before that write:
// the processing passes the count of such writes it saw before it read, and
// when the mirror counts more now, the read's open or closed state is not
// compared, only its assignees, which Tiehall never writes; the delivery the
// write causes, the poll or the reconciliation reads the issue again. Each change it shows besides, a close, a reopen or new
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
// mirror is the one that the mapping of the request's target team made, for
// its key there, while that mapping holds (mirrors.ts), not one a
// reassignment or a change of the mapping left behind, the
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

/**
 * The notice on a request that a person closed its mirror issue, in
 * Tiehall's words: the tracker, the key the issue mirrors, and that the
 * request, by its key now, stays in its state.
 */
export function mirrorClosedText({ tracker, mirroredKey, key, state }: { tracker: string; mirroredKey: string; key: string; state: string }): string {
  const name = TRACKER_NAMES[tracker] ?? tracker;
  return `The ${name} mirror issue of ${mirroredKey} was closed. A close in ${name} does not change the request: ${key} is still ${state}.`;
}

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
async function proposerOf(
  context: HandlerContext,
  request: RequestRow,
  mirror: { id: string; teamId: string; number: number | null },
): Promise<Member | undefined> {
  const userId = context.caller.kind === "integration_event" ? context.caller.userId : undefined;
  // Only the mirror that follows the request now: one a reassignment left behind is not its target team's.
  if (userId === undefined || mirror.teamId !== request.targetTeamId || (mirror.number !== null && mirror.number !== request.number)) return undefined;
  // Nor one whose mapping was removed, which Tiehall leaves as it is, even when a later mapping names its place.
  const [mapping] = await context.tx
    .select({ doneProposals: trackerMappings.doneProposals })
    .from(mirrors)
    .innerJoin(trackerMappings, madeBy())
    .where(and(eq(mirrors.orgId, context.orgId), eq(mirrors.id, mirror.id)));
  if (mapping?.doneProposals !== true) return undefined;
  if (!(await teamsOfMember(context, userId)).some(({ id }) => id === request.targetTeamId)) return undefined;
  if (!changeRequest(await lifecycleOf(context, request), { kind: "done" }).ok) return undefined;
  return memberOf(context, userId);
}

export const TRACKER_CHANGE_HANDLERS: Handlers = {
  [recordTrackerChange.id]: defineHandler(recordTrackerChange, async ({ mirrorId, issue, by, writesSeen, stateByOther, only }, context) => {
    if (context.caller.kind !== "integration_event") throw new Refusal("forbidden", "Only a change read from a tracker is recorded as one.");
    const { tx, orgId } = context;
    const [found] = await tx.select({ requestId: mirrors.requestId }).from(mirrors).where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)));
    if (found === undefined) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const request = await lockRequestById(context, found.requestId);
    const [row] = await tx
      .select({
        issue: mirrors.issue,
        teamId: mirrors.teamId,
        number: mirrors.number,
        tracker: mirrors.tracker,
        target: mirrors.target,
        trackerState: mirrors.trackerState,
        expectedState: mirrors.expectedState,
        stateWrites: mirrors.stateWrites,
      })
      .from(mirrors)
      .where(and(eq(mirrors.orgId, orgId), eq(mirrors.id, mirrorId)))
      .for("update");
    if (row === undefined || row.issue === null) throw new Refusal("record-not-found", "There is no such mirror issue.");
    const known = (row.trackerState as IssueState | null) ?? AS_MADE;
    // A write of the issue's state that began or ended since the read began may have come after it: the read may show
    // the issue as it was before that write, so its state is not compared, and a later read, such as the delivery the
    // write itself causes or the reconciliation, shows it. Tiehall writes no assignees, so they are.
    // A part of the read the call does not record, made by another account, is not compared either.
    const state = only !== "assignees" && row.stateWrites === writesSeen;
    const now: IssueState = {
      open: state ? issue.open : known.open,
      closeReason: state ? (issue.open ? null : issue.closeReason) : known.closeReason,
      assignees: only === "state" ? known.assignees : issue.assignees,
    };
    // A close or reopen the tracker says another account made is no echo of Tiehall's, even of a write that it began and
    // the tracker never applied. A change of the close reason alone is not one: GitHub keeps naming whoever closed the
    // issue as its closer when Tiehall changes only the reason, so that read may well be Tiehall's own write.
    const expected = stateByOther && now.open !== known.open ? null : (row.expectedState as Pick<IssueState, "open" | "closeReason"> | null);
    const changes: TrackerChange[] = trackerChanges(known, expected, now);
    const done = changes.some(isTrackerDone);
    const proposer = done ? await proposerOf(context, request, { id: mirrorId, teamId: row.teamId, number: row.number }) : undefined;
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
          const keys = new Map(
            (
              await writer.tx
                .select({ id: teams.id, key: teams.key })
                .from(teams)
                .where(and(eq(teams.orgId, writer.orgId), inArray(teams.id, [request.targetTeamId, row.teamId])))
            ).map(({ id, key }) => [id, key]),
          );
          const key = formatRequestKey(keys.get(request.targetTeamId) ?? "", request.number);
          // The key the issue mirrors, which a reassignment since may have left behind.
          const mirroredKey = row.number === null ? key : formatRequestKey(keys.get(row.teamId) ?? "", row.number);
          await addSystemMessage(
            writer,
            request.id,
            mirrorClosedText({ tracker: row.tracker, mirroredKey, key, state: request.state }),
            { actorKind: "system", surface: row.tracker === "jira" ? "jira" : "github" },
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
