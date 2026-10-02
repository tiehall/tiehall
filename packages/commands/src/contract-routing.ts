import { applyChangeSet, packet as packetSchema, type ContractSection, type Packet } from "@tiehall/catalog";
import { formatRequestKey, isTerminalState, requestOpened, requestStateChanged, type RequestLifecycle, type RequestState } from "@tiehall/core";
import { apiConsumers, apis, contractChangeRequests, contractChangeSets, contractReports, requests, teams } from "@tiehall/db";
import { and, asc, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { addSystemMessage } from "./messages.ts";
import { insertPacketRevision, packetRevisionOf, storePacketRevision } from "./packet-revisions.ts";
import { cancelProposals, lockPendingProposals } from "./proposals.ts";
import { fanOut, lockPullRequestChangeSets, recordWaiting } from "./contract-fan-out.ts";
import { requestingUserOf } from "./contract-requesters.ts";
import { lifecycleOf, lockRequestById, saveLifecycle, stampOf, transition } from "./request-changes.ts";
import type { RequestRow } from "./request-views.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import type { OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";
import type { Writer } from "./write.ts";

// Contract-change routing (contract-changes: Breaking changes open one request
// per consuming team; contract-changes: INFO-level changes appear only on
// existing requests; contract-changes: Bursts of reports are merged into one
// update; requests: System actions need no proposal or confirmation; requests:
// Provenance is stamped by the server; design.md, Decisions this change rests
// on: D14, D15; D28 #70, #71; D30 (3); design.md, Design rules: Contract
// changes; design.md, Readings to confirm with the founder: R19).
//
// A change set is one provider pull request against one registered API: the
// reports of CI runs for that API about that pull request, in the repository
// the API is bound to. contract.report stores each report with its change
// set, which it makes on the change set's first report.
//
// Bursts. Reports for one change set within 2 minutes of each other are
// merged into one update, which reflects the latest of them. The 2 minutes
// start with the first report of a burst, which contract.report records on
// the change set when no burst waits, starting, in its transaction, the
// worker's job that applies the update 2 minutes later. A report within those
// 2 minutes joins the burst. When the job runs, its update applies the latest
// report received by the burst's end, and the first report received after it,
// if any, starts the next burst, with a job of its own 2 minutes after that
// report; so an update never waits more than 2 minutes, however often reports
// come, and a report that came while an update was overdue, such as while the
// worker was stopped, is applied by the next.
//
// The update. The job runs the internal system command
// contract.apply_change_set as a system job from GitHub, so what it changes
// takes effect with no proposal and no confirmation and is recorded with the
// actor kind system and the surface github. The command locks the change
// set's row, so the updates and reports of one change set take turns, and
// does nothing before its burst's end, for which it waits again. Then, unless
// an update applied that report already:
// - each request of the change set that is not in a terminal state gets the
//   report's contract section as its packet's next revision, a system action
//   that takes effect also while the request is claimed, and cancels a pending
//   proposed packet change based on an earlier revision as stale, with a
//   system message in Tiehall's words that states how the number of breaking
//   changes changed from the request's current packet to the report, such as
//   "Diff updated: 2 → 3 breaking"; each request of the change set in a
//   terminal state (done, declined or withdrawn) gets only a notice of the
//   update, in the same words, and keeps its packet and its state (contract-
//   changes: Each update adds a packet revision and a system message;
//   handoff-packet: Packet changes that are commitments);
// - when the report holds no change that opens requests, each of those
//   requests that is unclaimed at that moment, whatever claims it had before,
//   is then withdrawn, as a system withdrawal with no proposal and no
//   confirmation, which cancels its pending proposals as every terminal state
//   does; a claimed one keeps its state; the system message of each says that
//   the breaking changes are gone, and which of the two the update did
//   (contract-changes: Requests are withdrawn when the breaking changes
//   disappear; requests: System withdrawals never touch a claimed request).
//   A later report of the change set that brings breaking changes back opens
//   no second request for a team, whose withdrawn request gets a notice;
// - the changes that open requests are the report's ERR-level ones; when there
//   are some, each team that declared it consumes the API, while the API is
//   registered, and has no request for the change set gets one, within the
//   limit of 10 consumer teams a pull request reaches without an admin
//   (contract-fan-out.ts): addressed to the team, from the pull request's
//   author while a member of the install, with the API's provider team as the
//   requesting team, or else from the provider team alone
//   (contract-requesters.ts), with a title and a need in Tiehall's words, and
//   a packet of the kind contract_change whose contract
//   section carries the report's API, refs and SHAs, engine, provider pull
//   request, and every classified change with its level, ERR, WARN and INFO
//   alike, so INFO-level changes appear only in the change lists of the
//   requests other changes opened; a report with no ERR-level change opens
//   nothing, whatever it holds.
// A team has one request for the change set, its latest, which the updates
// revise or notify: while the provider pull request is closed without
// merging, an update opens nothing, and once it is reopened, a team whose
// request the close withdrew gets a new one from the first report received
// after the close, which replaces the withdrawn one (provider-pull-requests.ts;
// contract-changes: Requests are withdrawn when the provider PR closes
// unmerged).
// The requests a report opens are not held to the target team's required
// fields, which apply to the requests people and agents open (design.md,
// Readings to confirm with the founder: R10).
//
// The locks follow the lock order (event-sequence.ts): the rows of the pull
// request's change sets, in the order of their ids, then the rows of the
// change set's requests that get a revision or a notice, in the order of
// their ids, then the pending proposals of those that get a revision, then
// the teams' next request numbers, in the order of the teams' ids, all before
// the update's first event.

/** How long a burst of reports for one change set lasts, from its first report. */
export const BURST_MS = 2 * 60 * 1000;

/** When a burst that started at this time ends, and its update is applied. */
export function burstEnd(startedAt: Date): Date {
  return new Date(startedAt.getTime() + BURST_MS);
}

/** The change set's update, applied by the worker: its job's data. */
export interface ApplyChangeSetData extends Record<string, unknown> {
  changeSetId: string;
}

/** The job that applies a change set's update, as the system from GitHub. */
export const applyChangeSets: WorkerJob<ApplyChangeSetData> = {
  type: defineJobType<ApplyChangeSetData>("contract.apply_change_set", 1, {
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  }),
  async handle(job, { execute }) {
    if (execute === undefined) throw new Error("The worker applies a change set's update through execute().");
    await execute(applyChangeSet.id, { kind: "system_job", job: job.queue, surface: "github" }, { changeSet: job.data.changeSetId });
  },
};

/** A report as an update applies it. */
interface StoredReport {
  id: string;
  pullRequestNumber: number;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  engineName: string;
  engineVersion: string;
  changes: ContractSection["changes"];
  receivedAt: Date;
  /** The provider pull request's author, by GitHub's id, as the App read it when the report came; null when it could not be known. */
  authorGitHubId: number | null;
}

type ChangeSetRow = Awaited<ReturnType<typeof lockPullRequestChangeSets>>;

const REPORT_COLUMNS = {
  id: contractReports.id,
  pullRequestNumber: contractReports.pullRequestNumber,
  baseRef: contractReports.baseRef,
  baseSha: contractReports.baseSha,
  headRef: contractReports.headRef,
  headSha: contractReports.headSha,
  engineName: contractReports.engineName,
  engineVersion: contractReports.engineVersion,
  changes: contractReports.changes,
  receivedAt: contractReports.receivedAt,
  authorGitHubId: contractReports.authorGitHubId,
};

/** The reports of the change set, as a condition. */
function ofChangeSet(orgId: string, changeSet: ChangeSetRow) {
  return and(
    eq(contractReports.orgId, orgId),
    eq(contractReports.apiId, changeSet.apiId),
    eq(contractReports.repositoryId, changeSet.repositoryId),
    eq(contractReports.pullRequestNumber, changeSet.pullRequestNumber),
  );
}

/** The change set's latest report received by this time, by its time and then its id. */
async function latestReportBy({ tx, orgId }: OrgContext, changeSet: ChangeSetRow, by: Date): Promise<StoredReport | undefined> {
  const [row] = await tx
    .select(REPORT_COLUMNS)
    .from(contractReports)
    .where(and(ofChangeSet(orgId, changeSet), lte(contractReports.receivedAt, by)))
    .orderBy(desc(contractReports.receivedAt), desc(contractReports.id))
    .limit(1);
  return row === undefined ? undefined : { ...row, changes: row.changes as ContractSection["changes"] };
}

/** A report of the change set by its id. */
async function reportById({ tx, orgId }: OrgContext, reportId: string): Promise<StoredReport | undefined> {
  const [row] = await tx
    .select(REPORT_COLUMNS)
    .from(contractReports)
    .where(and(eq(contractReports.orgId, orgId), eq(contractReports.id, reportId)));
  return row === undefined ? undefined : { ...row, changes: row.changes as ContractSection["changes"] };
}

/** When the change set's first report received after this time came, which starts its next burst; undefined when none came. */
async function firstReportAfter({ tx, orgId }: OrgContext, changeSet: ChangeSetRow, after: Date): Promise<Date | undefined> {
  const [row] = await tx
    .select({ receivedAt: contractReports.receivedAt })
    .from(contractReports)
    .where(and(ofChangeSet(orgId, changeSet), gt(contractReports.receivedAt, after)))
    .orderBy(asc(contractReports.receivedAt), asc(contractReports.id))
    .limit(1);
  return row?.receivedAt;
}

/** The teams that declared they consume the API, while it is registered: oldest declaration first, then by team key. */
async function consumingTeams({ tx, orgId }: OrgContext, apiId: string): Promise<{ id: string; key: string; declaredAt: Date }[]> {
  return tx
    .select({ id: teams.id, key: teams.key, declaredAt: apiConsumers.declaredAt })
    .from(apiConsumers)
    .innerJoin(apis, and(eq(apis.orgId, apiConsumers.orgId), eq(apis.id, apiConsumers.apiId)))
    .innerJoin(teams, and(eq(teams.orgId, apiConsumers.orgId), eq(teams.id, apiConsumers.teamId)))
    .where(and(eq(apiConsumers.orgId, orgId), eq(apiConsumers.apiId, apiId), isNull(apis.unregisteredAt)))
    .orderBy(asc(apiConsumers.declaredAt), asc(teams.key));
}

/** A request of the change set: the team it was opened to, its key and its state now. */
export interface ChangeSetRequest {
  requestId: string;
  teamId: string;
  key: string;
  state: RequestState;
  /** When the provider pull request's close without merging withdrew it; null otherwise. */
  withdrawnOnCloseAt: Date | null;
}

/**
 * The change set's request to each team it reached, oldest first: the latest
 * request the change set's updates opened to the team, since a team whose
 * request the provider pull request's close withdrew gets a new one once the
 * pull request is reopened, which replaces the withdrawn one.
 */
export async function requestsOfChangeSet({ tx, orgId }: OrgContext, changeSetId: string): Promise<ChangeSetRequest[]> {
  const rows = await tx
    .selectDistinctOn([contractChangeRequests.teamId], {
      requestId: contractChangeRequests.requestId,
      teamId: contractChangeRequests.teamId,
      openedAt: contractChangeRequests.openedAt,
      withdrawnOnCloseAt: contractChangeRequests.withdrawnOnCloseAt,
      state: requests.state,
      number: requests.number,
      teamKey: teams.key,
    })
    .from(contractChangeRequests)
    .innerJoin(requests, and(eq(requests.orgId, contractChangeRequests.orgId), eq(requests.id, contractChangeRequests.requestId)))
    .innerJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
    .where(and(eq(contractChangeRequests.orgId, orgId), eq(contractChangeRequests.changeSetId, changeSetId)))
    .orderBy(asc(contractChangeRequests.teamId), desc(contractChangeRequests.openedAt), desc(contractChangeRequests.requestId));
  return rows
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || (a.requestId < b.requestId ? -1 : 1))
    .map(({ requestId, teamId, state, number, teamKey, withdrawnOnCloseAt }) => ({
      requestId,
      teamId,
      key: formatRequestKey(teamKey, number),
      state: state as RequestState,
      withdrawnOnCloseAt,
    }));
}

/** "1 X" or "N Xs". */
function counted(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`;
}

/** How many ERR-level changes, which break the contract, a packet's contract section lists; 0 for a packet without one. */
function breakingIn(packet: Packet): number {
  return (packet.untrusted.contract?.changes ?? []).filter(({ level }) => level === "ERR").length;
}

/** What an update did to a request of the change set, which its message says. */
type UpdateOutcome =
  /** It added this revision, and the request goes on, since the changes still open requests. */
  | { kind: "revised"; revision: number }
  /** It added this revision, and the changes no longer open any request, so the request was withdrawn, unclaimed, or stays as it is, claimed. */
  | { kind: "gone"; revision: number; withdrawn: boolean }
  /** The request is in a terminal state: it keeps its packet at this revision, and gets only this notice. */
  | { kind: "notice"; revision: number };

/**
 * What an update says on a request of the change set, in Tiehall's words: how
 * the number of breaking changes changed from the request's packet to the
 * report, and what the update did to the request.
 */
function updateText(section: ContractSection, report: StoredReport, request: { key: string; state: RequestState; before: number }, outcome: UpdateOutcome): string {
  const after = section.changes.filter(({ level }) => level === "ERR").length;
  const pr = `${section.provider_pr.repository}#${section.provider_pr.number}`;
  const head = `Diff updated: ${request.before} → ${after} breaking. The contract Action reported ${pr} again, at commit ${report.headSha.slice(0, 12)}`;
  const listed = `${head}: packet revision ${outcome.revision} lists the ${counted(section.changes.length, "change")} to ${section.api} that the diff engine classified, each with its level.`;
  switch (outcome.kind) {
    case "revised":
      return listed;
    case "gone": {
      const gone = `The breaking changes are gone: ${pr} no longer makes a change to ${section.api} that opens requests.`;
      return outcome.withdrawn
        ? `${listed} ${gone} Nobody had claimed ${request.key}, so Tiehall withdrew ${request.key}.`
        : `${listed} ${gone} ${request.key} is claimed, so Tiehall leaves it as it is.`;
    }
    case "notice":
      return `${head}. ${request.key} is ${request.state}, so its packet stays at revision ${outcome.revision}.`;
  }
}

/** The contract section of a report, for the API at its repository. */
function contractSectionOf(report: StoredReport, api: { name: string; repositoryFullName: string }): ContractSection {
  return {
    api: api.name,
    base: { ref: report.baseRef, sha: report.baseSha },
    head: { ref: report.headRef, sha: report.headSha },
    engine: { name: report.engineName, version: report.engineVersion },
    changes: report.changes,
    provider_pr: { repository: api.repositoryFullName, number: report.pullRequestNumber, url: `https://github.com/${api.repositoryFullName}/pull/${report.pullRequestNumber}` },
    provider_status: "open",
  };
}

/** The packet a contract-change request is opened with: Tiehall's words for the need, and the report's contract section. */
function packetOf(section: ContractSection, team: string): Packet {
  const breaking = section.changes.filter(({ level }) => level === "ERR").length;
  const pr = `${section.provider_pr.repository}#${section.provider_pr.number}`;
  const need =
    `The provider pull request ${pr} makes ${counted(breaking, "breaking change")} to ${section.api}, which ${team} declared it consumes. ` +
    "The contract section lists every change the diff engine classified, each with its level. " +
    `Change how ${team} uses ${section.api} before the provider change ships, and close this request with ${team}'s own pull request, one that mentions this request's key or is linked to it.`;
  return packetSchema.parse({ schema_version: "1-beta", kind: "contract_change", untrusted: { need, contract: section } });
}

/** The title of a contract-change request, in Tiehall's words, within the 200 characters of a title. */
function titleOf(section: ContractSection): string {
  return `Breaking changes to ${section.api} in ${section.provider_pr.repository}#${section.provider_pr.number}`.slice(0, 200);
}

/**
 * Withdraws an unclaimed request as a system withdrawal, with no proposal and
 * no confirmation (requests: System withdrawals never touch a claimed
 * request): its state change, recorded with the write's provenance, and the
 * cancellation of its pending proposals, which a terminal state ends. The
 * caller holds the request's row and its pending proposals, and has found it
 * unclaimed.
 */
export async function withdrawAsSystem(writer: Writer, requestId: string, current: RequestLifecycle): Promise<void> {
  if (current.claimantId !== null) throw new Error("A system withdrawal never touches a claimed request.");
  const next = transition(current, { kind: "withdraw" });
  await saveLifecycle(writer, requestId, next);
  await writer.record(requestStateChanged, { requestId, state: next.state, previousState: current.state });
  await cancelProposals(writer, requestId, { kind: "terminal_state" });
}

/** By id, for the lock order. */
const byId = <T>(id: (item: T) => string) => (a: T, b: T) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

/**
 * Applies a change set's update, as contract.apply_change_set does: a burst's
 * latest report once the burst has ended, and the fan-out of the change set's
 * latest applied report; returns the keys of the requests it opened.
 */
async function applyUpdate(context: HandlerContext, changeSetId: string): Promise<{ opened: string[] }> {
  const { tx, orgId } = context;
  const changeSet = await lockPullRequestChangeSets(context, changeSetId);
  // The report a burst that has ended brings, if it is new.
  let report: StoredReport | undefined;
  if (changeSet.burstStartedAt !== null) {
    const end = burstEnd(changeSet.burstStartedAt);
    if (context.now().getTime() < end.getTime()) {
      // Early, such as a job of a burst that has not ended: the burst's update waits for its end.
      await context.enqueue(applyChangeSets.type, { changeSetId }, { startAfter: end });
    } else {
      // The burst ends here; the first report after it starts the next.
      const next = await firstReportAfter(context, changeSet, end);
      await tx
        .update(contractChangeSets)
        .set({ burstStartedAt: next ?? null })
        .where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.id, changeSet.id)));
      if (next !== undefined) await context.enqueue(applyChangeSets.type, { changeSetId }, { startAfter: burstEnd(next) });
      const latest = await latestReportBy(context, changeSet, end);
      if (latest !== undefined && latest.id !== changeSet.appliedReportId) report = latest;
    }
  }
  // The change set's latest report: the new one, or the one an earlier update applied, whose fan-out an admin may have confirmed since.
  const current = report ?? (changeSet.appliedReportId === null ? undefined : await reportById(context, changeSet.appliedReportId));
  if (current === undefined) return { opened: [] };
  const [api] = await tx
    .select({ name: apis.name, providerTeamId: apis.providerTeamId, repositoryFullName: apis.repositoryFullName })
    .from(apis)
    .where(and(eq(apis.orgId, orgId), eq(apis.id, changeSet.apiId)));
  if (api === undefined) throw new Error("A change set names an API the install does not have.");
  const markApplied = async () => {
    if (report === undefined) return;
    await tx.update(contractChangeSets).set({ appliedReportId: report.id }).where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.id, changeSet.id)));
  };

  const section = contractSectionOf(current, api);
  const existing = await requestsOfChangeSet(context, changeSet.id);
  const opening = current.changes.some(({ level }) => level === "ERR");
  // Who may get a request: a consuming team that has none for the change set, or whose request the provider pull
  // request's close withdrew before this report came, once the pull request is open again; nobody while it is closed.
  const opensFor = (teamId: string) => {
    const request = existing.find((candidate) => candidate.teamId === teamId);
    return request === undefined || (request.withdrawnOnCloseAt !== null && current.receivedAt.getTime() >= request.withdrawnOnCloseAt.getTime());
  };
  const candidates = opening && changeSet.providerClosedAt === null ? (await consumingTeams(context, changeSet.apiId)).filter(({ id }) => opensFor(id)) : [];
  const { letIn: toOpen, waiting } = await fanOut(context, changeSet, candidates);
  await recordWaiting(context, changeSet, waiting);
  // A new report updates every request of the change set: a revision where it has not ended, a notice where it has;
  // a team's withdrawn request that a new one replaces gets nothing more.
  const toUpdate = report === undefined ? [] : existing.filter(({ teamId }) => !toOpen.some(({ id }) => id === teamId)).sort(byId(({ requestId }) => requestId));
  const toRevise = toUpdate.filter(({ state }) => !isTerminalState(state));
  // The requester of the requests it opens: the pull request's author while a member of the install, or the provider team alone.
  const requestingUserId = toOpen.length === 0 ? null : await requestingUserOf(context, current.authorGitHubId);
  if (toUpdate.length === 0 && toOpen.length === 0) {
    await markApplied();
    return { opened: [] };
  }
  return context.write(async (writer) => {
    // Every lock before the update's first event: the requests' rows, the pending proposals of those it revises, then the teams' next numbers.
    const rows = new Map<string, RequestRow>();
    for (const { requestId } of toUpdate) rows.set(requestId, await lockRequestById(writer, requestId));
    for (const { requestId } of toRevise) await lockPendingProposals(writer, requestId);
    const numbers = new Map<string, number>();
    for (const team of [...toOpen].sort(byId(({ id }) => id))) numbers.set(team.id, await takeRequestNumber(writer, team.id));

    for (const request of toUpdate) {
      const { packet: currentPacket, revision } = await packetRevisionOf(writer, request.requestId);
      const before = breakingIn(currentPacket as Packet);
      if (isTerminalState(request.state)) {
        await writer.changesRequest(request.requestId);
        await addSystemMessage(writer, request.requestId, updateText(section, current, { ...request, before }, { kind: "notice", revision }));
        continue;
      }
      const row = rows.get(request.requestId);
      if (row === undefined) throw new Error("The update locks every request it changes before its first event.");
      const lifecycle = await lifecycleOf(writer, row);
      const revised = await storePacketRevision(
        writer,
        request.requestId,
        { ...currentPacket, untrusted: { ...currentPacket.untrusted, contract: section } } as Packet,
        stampOf(writer.provenance, undefined),
      );
      if (opening) {
        await addSystemMessage(writer, request.requestId, updateText(section, current, { ...request, before }, { kind: "revised", revision: revised }));
        continue;
      }
      // No change opens requests any more: a system withdrawal of an unclaimed request; a claimed one stays as it is.
      const withdrawn = lifecycle.claimantId === null;
      await addSystemMessage(writer, request.requestId, updateText(section, current, { ...request, before }, { kind: "gone", revision: revised, withdrawn }));
      if (withdrawn) await withdrawAsSystem(writer, request.requestId, lifecycle);
    }
    const opened: string[] = [];
    for (const team of toOpen) {
      const number = numbers.get(team.id) ?? 0;
      const [row] = await writer.tx
        .insert(requests)
        .values({ orgId: writer.orgId, targetTeamId: team.id, number, title: titleOf(section), requestingUserId, requestingTeamId: api.providerTeamId })
        .returning({ id: requests.id });
      if (row === undefined) throw new Error("The new request was not returned.");
      await insertPacketRevision(writer, row.id, 1, packetOf(section, team.key), stampOf(writer.provenance, undefined));
      await writer.tx.insert(contractChangeRequests).values({ orgId: writer.orgId, requestId: row.id, changeSetId: changeSet.id, teamId: team.id });
      await writer.record(requestOpened, { requestId: row.id, targetTeamId: team.id, requestingTeamId: api.providerTeamId });
      opened.push(formatRequestKey(team.key, number));
    }
    await markApplied();
    return { opened };
  });
}

export const CONTRACT_ROUTING_HANDLERS: Handlers = {
  [applyChangeSet.id]: defineHandler(applyChangeSet, async ({ changeSet }, context) => applyUpdate(context, changeSet)),
};
