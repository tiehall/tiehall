import { closeOnMerge, MENTIONS_MAX } from "@tiehall/catalog";
import { REQUEST_KEY, Refusal, requestStateChanged, type RequestLifecycle } from "@tiehall/core";
import { contractChangeRequests, contractChangeSets, events, pullRequestLinks } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { coveringInstallation } from "./github-installations.ts";
import { addSystemMessage } from "./messages.ts";
import { cancelProposals, lockPendingProposals } from "./proposals.ts";
import { lifecycleOf, lockRequestById, saveLifecycle, transition } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { requestView, type RequestRow } from "./request-views.ts";

// Close on merge (requests: Linked PRs and done on merge; requests: System
// actions need no proposal or confirmation; contract-changes: Consumers close
// requests with their own PR; agent-access: Six kinds of caller; design.md,
// Decisions this change rests on: D14, D23, D37; design.md, Design rules:
// Requests and events; design.md, Self-hosting decisions: S4). When the pull
// request processor (pull-request-processing.ts) reads from GitHub that a pull
// request of a covered repository has merged, it runs requests.close_on_merge
// with the pull request's repository, number and merge time, and the request
// keys its title, body and branch name mention (mentionedKeys), as the
// integration event from GitHub: it acts for the Tiehall user of the delivery's
// sender while that user is a member of the install, and for no user
// otherwise, as for a merge the poll found, so a removed person's merge
// closes the request in nobody's name. The command moves a request to done, as
// a system action with no proposal and no confirmation, when:
// - the pull request was linked to it at or before the second it merged, or
//   its title, body or branch name mentions its key, a key written with its
//   team's current key, an earlier key of its team, or a key it had before a
//   confirmed reassignment, in either case;
// - it was claimed at or before the second the pull request merged, and is
//   claimed still: GitHub gives merge times to the second, so a claim taken in
//   the second a pull request merged counts as taken before the merge;
// - it is claimed, in_progress or needs_info, with a claimant;
// - and the repository is covered by a connected installation now.
// The provider pull request of a contract-change request's own change set
// never closes it, even when it mentions the request's key or was linked to
// it: its merge marks the provider change shipped instead
// (provider-pull-requests.ts). The move to done records its state change,
// with the caller's provenance, cancels the request's pending proposals as
// every terminal state does, and adds a notice in Tiehall's words that names
// the pull request. A request already done, or one that does not qualify,
// does not change, so processing the same merge again changes nothing.
//
// Reading: "mentions the key" is read without regard to case, since branch
// names are often written in lower case, such as fe-142-new-fields; the
// mention is a request key with no letter or digit right before it and no
// digit right after it.
//
// The locks follow the lock order (event-sequence.ts): the rows of the
// requests it may close, in the order of their ids, then the pending
// proposals of those it closes, all before the first event.

/** A request key as a pull request's text may write it, in either case: a team key, a hyphen and a number. */
const MENTION = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,9})(?![0-9])/g;

/** The request keys these texts mention, in upper case, each once, in the order they first appear; at most MENTIONS_MAX. */
export function mentionedKeys(...texts: readonly string[]): string[] {
  const keys: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(MENTION)) {
      const key = `${(match[1] ?? "").toUpperCase()}-${match[2] ?? ""}`;
      if (!REQUEST_KEY.test(key) || keys.includes(key)) continue;
      keys.push(key);
      if (keys.length === MENTIONS_MAX) return keys;
    }
  }
  return keys;
}

/** When the request's current claim was taken: its recorded time, or, for a claim taken before Tiehall recorded it, its claim's event. */
async function claimedAtOf(context: HandlerContext, row: RequestRow): Promise<Date | undefined> {
  if (row.claimedAt !== null) return row.claimedAt;
  const [claimed] = await context.tx
    .select({ at: sql<Date | null>`max(${events.occurredAt})` })
    .from(events)
    .where(and(eq(events.orgId, context.orgId), eq(events.type, "request.claimed"), sql`${events.data} ->> 'requestId' = ${row.id}`));
  return claimed?.at === null || claimed?.at === undefined ? undefined : new Date(claimed.at);
}

/** Whether the request qualifies: claimed, in_progress or needs_info with a claimant, claimed at or before the second the pull request merged. */
async function closesOnMerge(context: HandlerContext, row: RequestRow, lifecycle: RequestLifecycle, mergedAt: Date): Promise<boolean> {
  if (!["claimed", "in_progress", "needs_info"].includes(lifecycle.state) || lifecycle.claimantId === null) return false;
  const claimedAt = await claimedAtOf(context, row);
  if (claimedAt === undefined) return false;
  return Math.floor(claimedAt.getTime() / 1000) * 1000 <= mergedAt.getTime();
}

/** The ids of the requests the merged pull request may close: linked at or before the second it merged, or mentioned. */
async function candidatesOf(context: HandlerContext, input: { repository: string; number: number; mergedAt: Date; mentions: readonly string[] }): Promise<string[]> {
  const [owner = "", name = ""] = input.repository.toLowerCase().split("/");
  const linked = await context.tx
    .select({ requestId: pullRequestLinks.requestId })
    .from(pullRequestLinks)
    .where(
      and(
        eq(pullRequestLinks.orgId, context.orgId),
        eq(pullRequestLinks.repositoryOwner, owner),
        eq(pullRequestLinks.repositoryName, name),
        eq(pullRequestLinks.number, input.number),
        sql`date_trunc('second', ${pullRequestLinks.linkedAt}) <= ${input.mergedAt.toISOString()}::timestamptz`,
      ),
    );
  const ids = new Set(linked.map(({ requestId }) => requestId));
  for (const key of input.mentions) {
    try {
      ids.add((await resolveRequestKey(context, key)).requestId);
    } catch (error) {
      // A mention of a key no request has, such as a ticket of another tracker, closes nothing.
      if (!(error instanceof Refusal)) throw error;
    }
  }
  return [...ids];
}

/** The ids of the requests of the pull request's own contract change sets, which it never closes. */
async function ownChangeSetRequests(context: HandlerContext, repositoryId: number, number: number): Promise<Set<string>> {
  const rows = await context.tx
    .select({ requestId: contractChangeRequests.requestId })
    .from(contractChangeRequests)
    .innerJoin(contractChangeSets, and(eq(contractChangeSets.orgId, contractChangeRequests.orgId), eq(contractChangeSets.id, contractChangeRequests.changeSetId)))
    .where(and(eq(contractChangeRequests.orgId, context.orgId), eq(contractChangeSets.repositoryId, repositoryId), eq(contractChangeSets.pullRequestNumber, number)));
  return new Set(rows.map(({ requestId }) => requestId));
}

export const CLOSE_ON_MERGE_HANDLERS: Handlers = {
  [closeOnMerge.id]: defineHandler(closeOnMerge, async ({ repositoryId, repository, number, mergedAt, mentions }, context) => {
    if ((await coveringInstallation(context, repositoryId)) === undefined) return { done: [] };
    const merged = new Date(mergedAt);
    const own = await ownChangeSetRequests(context, repositoryId, number);
    const candidates = (await candidatesOf(context, { repository, number, mergedAt: merged, mentions })).filter((id) => !own.has(id)).sort();
    const closing: { row: RequestRow; lifecycle: RequestLifecycle }[] = [];
    for (const requestId of candidates) {
      const row = await lockRequestById(context, requestId);
      const lifecycle = await lifecycleOf(context, row);
      if (await closesOnMerge(context, row, lifecycle, merged)) closing.push({ row, lifecycle });
    }
    if (closing.length === 0) return { done: [] };
    return context.write(async (writer) => {
      for (const { row } of closing) await lockPendingProposals(writer, row.id);
      const done: string[] = [];
      for (const { row, lifecycle } of closing) {
        const { key } = await requestView(writer, row.id);
        await writer.changesRequest(row.id);
        const next = transition(lifecycle, { kind: "done" });
        await saveLifecycle(writer, row.id, next);
        await writer.record(requestStateChanged, { requestId: row.id, state: next.state, previousState: lifecycle.state });
        await cancelProposals(writer, row.id, { kind: "terminal_state" });
        await addSystemMessage(writer, row.id, `${repository}#${number} merged after ${key} was claimed, so ${key} moved to done.`, { actorKind: "system", surface: "github" });
        done.push(key);
      }
      return { done };
    });
  }),
};
