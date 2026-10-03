import { closeOnMerge, MENTIONS_MAX } from "@tiehall/catalog";
import { REQUEST_KEY, Refusal, requestStateChanged, type RequestLifecycle } from "@tiehall/core";
import { contractChangeRequests, contractChangeSets, events, pullRequestLinks, pullRequestMentions, pullRequestMerges } from "@tiehall/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { coveringInstallation } from "./github-installations.ts";
import { addSystemMessage } from "./messages.ts";
import { cancelProposals, lockPendingProposals } from "./proposals.ts";
import { lifecycleOf, lockRequestById, saveLifecycle, transition } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
import { requestView, type RequestRow } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

/** The notice on a request that a merge closed, in Tiehall's words: the pull request, as GitHub names it, and the request's key. */
export function mergedText({ pullRequest, key }: { pullRequest: string; key: string }): string {
  return `${pullRequest} merged after ${key} was claimed, so ${key} moved to done.`;
}

// Close on merge (requests: Linked PRs and done on merge; requests: System
// actions need no proposal or confirmation; contract-changes: Consumers close
// requests with their own PR; agent-access: Six kinds of caller; design.md,
// Decisions this change rests on: D14, D23, D37; design.md, Design rules:
// Requests and events; design.md, Self-hosting decisions: S4). When the pull
// request processor (pull-request-processing.ts) reads from GitHub that a pull
// request of a covered repository has merged, it runs requests.close_on_merge
// with the pull request's repository, number and merge time, and the request
// keys it mentioned before it merged (below), as the integration event from
// GitHub: it acts for the Tiehall user of the delivery's sender while that
// user is a member of the install, and for no user otherwise, as for a merge
// the poll found, so a removed person's merge closes the request in nobody's
// name. The command moves a request to done, as a system action with no
// proposal and no confirmation, when:
// - the pull request was linked to it at or before the second it merged, or
//   mentioned its key in its title, body or branch name before it merged, a
//   key written with its team's current key, an earlier key of its team, or a
//   key it had before a confirmed reassignment, in either case;
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
// the pull request.
//
// Only a mention made before the merge counts, and GitHub gives a merged pull
// request's title and body as they are now, with any edit made after the
// merge, even one made before Tiehall processes the merge. So the processor
// reads them while the pull request is open: each read that finds it open
// records the keys its title, body and branch name mention then
// (pull_request_mentions, recordOpenMentions), the latest read by GitHub's
// update time replacing what an earlier one recorded, and a read that finds
// it open and mentioning no key recording no key. The record keeps the update
// time of every read it took, one that found no key too, so a read GitHub
// gave an earlier update time, which ends after a later one, changes
// nothing. A merged pull request's
// mentions are the keys of the latest read that found it open, and the keys
// its branch name mentions, which GitHub gives as the branch the pull request
// was opened from and which no edit of the pull request changes. A key written
// into the title or body after the merge, or before the merge but read by no
// processing while the pull request was open, closes nothing; a link counts
// when it was made at or before the second the pull request merged.
//
// Close on merge also runs once per merge: at the first processing that reads
// the pull request merged in a covered repository, which records the merge
// (pull_request_merges) in the transaction that closes its requests. A later
// processing of the same merge, which a redelivery, a delivery about an edit
// or the poll brings, changes nothing.
//
// Reading: "mentions the key" is read without regard to case, since branch
// names are often written in lower case, such as fe-142-new-fields; the
// mention is a request key with no letter or digit right before it and no
// digit right after it.
//
// The locks follow the lock order (event-sequence.ts): the record of the
// merge, which a second processing of the same merge waits on and then finds,
// then the rows of the requests it may close, in the order of their ids, then
// the pending proposals of those it closes, all before the first event.

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

/**
 * Records the request keys an open pull request's title, body and branch name
 * mention as a read found them, none included, with the update time GitHub
 * gave, the read GitHub updated last winning: a read that GitHub gave an
 * earlier update time than the record's changes nothing. Close on merge
 * counts these keys as mentioned before the pull request merged.
 */
export async function recordOpenMentions(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  read: { repositoryId: number; number: number; keys: readonly string[]; updatedAt: Date },
): Promise<void> {
  await tx
    .insert(pullRequestMentions)
    .values({ orgId, repositoryId: read.repositoryId, number: read.number, keys: [...read.keys], updatedAt: read.updatedAt })
    .onConflictDoUpdate({
      target: [pullRequestMentions.orgId, pullRequestMentions.repositoryId, pullRequestMentions.number],
      set: { keys: sql`excluded.keys`, updatedAt: sql`excluded.updated_at` },
      setWhere: lte(pullRequestMentions.updatedAt, sql`excluded.updated_at`),
    });
}

/** The request keys the latest read that found the pull request open recorded, or none. */
export async function openMentionsOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, repositoryId: number, number: number): Promise<string[]> {
  const [row] = await tx
    .select({ keys: pullRequestMentions.keys })
    .from(pullRequestMentions)
    .where(and(eq(pullRequestMentions.orgId, orgId), eq(pullRequestMentions.repositoryId, repositoryId), eq(pullRequestMentions.number, number)));
  return row?.keys ?? [];
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
    // Once per merge: a later processing of it finds the record and closes nothing.
    const [first] = await context.tx
      .insert(pullRequestMerges)
      .values({ orgId: context.orgId, repositoryId, number, mergedAt: merged, closeOnMergeAt: context.now() })
      .onConflictDoNothing()
      .returning({ number: pullRequestMerges.number });
    if (first === undefined) return { done: [] };
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
        await addSystemMessage(writer, row.id, mergedText({ pullRequest: `${repository}#${number}`, key }), { actorKind: "system", surface: "github" });
        done.push(key);
      }
      return { done };
    });
  }),
};
