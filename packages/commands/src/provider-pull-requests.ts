import { applyProviderPullRequest } from "@tiehall/catalog";
import { isTerminalState, requestProviderChangeShipped } from "@tiehall/core";
import { apis, contractChangeRequests, contractChangeSets } from "@tiehall/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { lockChangeSetsOfPullRequest } from "./contract-fan-out.ts";
import { applyChangeSets, requestsOfChangeSet, withdrawAsSystem, type ChangeSetRequest } from "./contract-routing.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { addSystemMessage } from "./messages.ts";
import { lockPendingProposals } from "./proposals.ts";
import { lifecycleOf, lockRequestById } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";

// What GitHub says of a provider pull request (contract-changes: Merging the
// provider PR marks the change shipped; contract-changes: Requests are
// withdrawn when the provider PR closes unmerged; requests: System
// withdrawals never touch a claimed request; requests: System actions need no
// proposal or confirmation; agent-access: Six kinds of caller; design.md,
// Decisions this change rests on: D23; D28 #74; design.md, Self-hosting
// decisions: S9). The pull request processor (pull-request-processing.ts)
// reads a pull request of a covered repository from GitHub, as it is now,
// whenever a delivery of the install's GitHub App or the poll of polling mode
// shows it, and runs contract.apply_provider_pull_request with what it read,
// as the system from GitHub, so what it changes is recorded with the actor
// kind system and the surface github, for no user, whoever closed the pull
// request. The command locks the change sets of the pull request, one per API
// it changes, in the order of their ids; a pull request no report named has
// none, and nothing happens.
//
// Merged. Each change set not marked merged yet is marked shipped, with the
// time the pull request merged, and every request it opened, whatever its
// state, gets a domain event that names it, which the tracker mirrors' jobs
// pick up; the requests show the provider change as shipped
// (request-views.ts), and none moves to done: each consumer closes its own
// request with its own pull request (contract-changes: Merging the provider
// PR marks the change shipped; contract-changes: Consumers close requests
// with their own PR).
//
// Closed without merging. Each change set that is not marked closed yet is
// marked so, and each of its requests, the latest one to each team, is
// handled in the order of their ids: one that is unclaimed at that moment and
// has not ended is withdrawn, as a system withdrawal with no proposal and no
// confirmation (contract-routing.ts), and remembers that the close withdrew
// it; one that is claimed keeps its state, and one in a terminal state too.
// Each gets a notice in Tiehall's words that the pull request closed without
// merging and what that did to it. Marking the change set closed makes the
// processing of the same close, which a redelivery or the poll brings again,
// change nothing more, and keeps its updates from opening requests while the
// pull request stays closed (contract-routing.ts).
//
// Open again after such a close. The change set is no longer marked closed,
// and its update runs at once: from the first report received after the
// close, it opens a new request to each consuming team whose request the
// close withdrew, which then replaces the withdrawn one, as the next report
// that the contract Action sends for the reopened pull request does if it
// comes later; the requests that stayed claimed get that report's revision.
//
// The locks follow the lock order (event-sequence.ts): the change sets, then
// the rows of their requests, in the order of their ids, then the pending
// proposals of those it withdraws, all before the first event.

/** A provider pull request's change set, with its API as the notices name it. */
interface ProviderChangeSet {
  id: string;
  pullRequestNumber: number;
  providerClosedAt: Date | null;
  providerMergedAt: Date | null;
  repositoryFullName: string;
}

/** What the close says on a request, in Tiehall's words. */
function closeText(pr: string, request: ChangeSetRequest, withdrawn: boolean): string {
  const closed = `The provider pull request ${pr} closed without merging.`;
  if (withdrawn) return `${closed} Nobody had claimed ${request.key}, so Tiehall withdrew ${request.key}. If ${pr} is reopened, the next contract report opens a new request.`;
  if (isTerminalState(request.state)) return `${closed} ${request.key} is ${request.state}, so it stays as it is.`;
  return `${closed} ${request.key} is claimed, so Tiehall leaves it as it is.`;
}

/** The API's repository of each change set, for the notices. */
async function withRepositories(
  context: HandlerContext,
  changeSets: readonly { id: string; apiId: string; pullRequestNumber: number; providerClosedAt: Date | null; providerMergedAt: Date | null }[],
): Promise<ProviderChangeSet[]> {
  if (changeSets.length === 0) return [];
  const rows = await context.tx
    .select({ id: apis.id, repositoryFullName: apis.repositoryFullName })
    .from(apis)
    .where(
      and(
        eq(apis.orgId, context.orgId),
        inArray(
          apis.id,
          changeSets.map(({ apiId }) => apiId),
        ),
      ),
    );
  return changeSets.map(({ id, apiId, pullRequestNumber, providerClosedAt, providerMergedAt }) => ({
    id,
    pullRequestNumber,
    providerClosedAt,
    providerMergedAt,
    repositoryFullName: rows.find((row) => row.id === apiId)?.repositoryFullName ?? "",
  }));
}

/** Marks the change sets' pull request closed without merging, and withdraws their unclaimed requests; returns the keys it withdrew. */
async function applyClose(context: HandlerContext, changeSets: readonly ProviderChangeSet[]): Promise<string[]> {
  const { tx, orgId } = context;
  const closing = changeSets.filter(({ providerClosedAt }) => providerClosedAt === null);
  if (closing.length === 0) return [];
  const now = context.now();
  await tx
    .update(contractChangeSets)
    .set({ providerClosedAt: now })
    .where(
      and(
        eq(contractChangeSets.orgId, orgId),
        inArray(
          contractChangeSets.id,
          closing.map(({ id }) => id),
        ),
      ),
    );
  const affected: { changeSet: ProviderChangeSet; request: ChangeSetRequest }[] = [];
  for (const changeSet of closing) for (const request of await requestsOfChangeSet(context, changeSet.id)) affected.push({ changeSet, request });
  if (affected.length === 0) return [];
  affected.sort((a, b) => (a.request.requestId < b.request.requestId ? -1 : 1));
  return context.write(async (writer) => {
    // Every lock before the first event: the requests' rows, then the pending proposals of those it withdraws.
    const rows = new Map<string, RequestRow>();
    for (const { request } of affected) rows.set(request.requestId, await lockRequestById(writer, request.requestId));
    const lifecycles = new Map<string, Awaited<ReturnType<typeof lifecycleOf>>>();
    for (const { request } of affected) {
      const row = rows.get(request.requestId);
      if (row === undefined) throw new Error("The close locks every request it changes before its first event.");
      const lifecycle = await lifecycleOf(writer, row);
      lifecycles.set(request.requestId, lifecycle);
      if (!isTerminalState(lifecycle.state) && lifecycle.claimantId === null) await lockPendingProposals(writer, request.requestId);
    }
    const withdrawn: string[] = [];
    for (const { changeSet, request } of affected) {
      const lifecycle = lifecycles.get(request.requestId);
      if (lifecycle === undefined) throw new Error("The close reads every request it changes before its first event.");
      const withdraws = !isTerminalState(lifecycle.state) && lifecycle.claimantId === null;
      const current = { ...request, state: lifecycle.state };
      await writer.changesRequest(request.requestId);
      await addSystemMessage(writer, request.requestId, closeText(`${changeSet.repositoryFullName}#${changeSet.pullRequestNumber}`, current, withdraws));
      if (!withdraws) continue;
      await withdrawAsSystem(writer, request.requestId, lifecycle);
      await writer.tx
        .update(contractChangeRequests)
        .set({ withdrawnOnCloseAt: writer.now() })
        .where(and(eq(contractChangeRequests.orgId, writer.orgId), eq(contractChangeRequests.requestId, request.requestId)));
      withdrawn.push(request.key);
    }
    return withdrawn;
  });
}

/**
 * Marks the provider change of the change sets shipped, when it merged, as
 * GitHub gives it, with a domain event on every request of each change set
 * not marked so before, whatever its state, and changes no request.
 */
async function applyMerge(context: HandlerContext, changeSets: readonly ProviderChangeSet[], mergedAt: Date): Promise<void> {
  const { tx, orgId } = context;
  const merging = changeSets.filter(({ providerMergedAt }) => providerMergedAt === null);
  if (merging.length === 0) return;
  const ids = merging.map(({ id }) => id);
  await tx
    .update(contractChangeSets)
    .set({ providerMergedAt: mergedAt, providerClosedAt: null })
    .where(and(eq(contractChangeSets.orgId, orgId), inArray(contractChangeSets.id, ids)));
  const shipped = await tx
    .select({ requestId: contractChangeRequests.requestId })
    .from(contractChangeRequests)
    .where(and(eq(contractChangeRequests.orgId, orgId), inArray(contractChangeRequests.changeSetId, ids)))
    .orderBy(asc(contractChangeRequests.requestId));
  if (shipped.length === 0) return;
  await context.write(async (writer) => {
    for (const { requestId } of shipped) await writer.record(requestProviderChangeShipped, { requestId });
  });
}

/** Marks the change sets of a pull request that is open again after a close as no longer closed, and updates them at once. */
async function applyReopen(context: HandlerContext, changeSets: readonly ProviderChangeSet[]): Promise<void> {
  const reopened = changeSets.filter(({ providerClosedAt }) => providerClosedAt !== null);
  for (const { id } of reopened) {
    await context.tx
      .update(contractChangeSets)
      .set({ providerClosedAt: null })
      .where(and(eq(contractChangeSets.orgId, context.orgId), eq(contractChangeSets.id, id)));
    await context.enqueue(applyChangeSets.type, { changeSetId: id }, { startAfter: context.now() });
  }
}

export const PROVIDER_PULL_REQUEST_HANDLERS: Handlers = {
  [applyProviderPullRequest.id]: defineHandler(applyProviderPullRequest, async ({ repositoryId, number, state, mergedAt }, context) => {
    const changeSets = await withRepositories(context, await lockChangeSetsOfPullRequest(context, repositoryId, number));
    if (state === "open") {
      await applyReopen(context, changeSets);
      return { withdrawn: [] };
    }
    if (mergedAt !== null) {
      await applyMerge(context, changeSets, new Date(mergedAt));
      return { withdrawn: [] };
    }
    return { withdrawn: await applyClose(context, changeSets) };
  }),
};
