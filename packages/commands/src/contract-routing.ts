import { applyChangeSet, packet as packetSchema, type ContractSection, type Packet } from "@tiehall/catalog";
import { formatRequestKey, isTerminalState, requestOpened, type RequestState } from "@tiehall/core";
import { apiConsumers, apis, contractChangeRequests, contractChangeSets, contractReports, requests, teams } from "@tiehall/db";
import { and, asc, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { insertPacketRevision, packetRevisionOf, storePacketRevision } from "./packet-revisions.ts";
import { lockPendingProposals } from "./proposals.ts";
import { fanOut, lockPullRequestChangeSets, recordWaiting } from "./contract-fan-out.ts";
import { lockRequestById, stampOf } from "./request-changes.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import type { OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

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
//   proposed packet change based on an earlier revision as stale (task 23.11
//   adds the system message and the notice on requests in a terminal state);
// - the changes that open requests are the report's ERR-level ones; when there
//   are some, each team that declared it consumes the API, while the API is
//   registered, and has no request for the change set gets one: addressed to
//   the team, from the API's provider team, with a title and a need in
//   Tiehall's words, and a packet of the kind contract_change whose contract
//   section carries the report's API, refs and SHAs, engine, provider pull
//   request, and every classified change with its level, ERR, WARN and INFO
//   alike, so INFO-level changes appear only in the change lists of the
//   requests other changes opened; a report with no ERR-level change opens
//   nothing, whatever it holds.
// The requests a report opens are not held to the target team's required
// fields, which apply to the requests people and agents open (design.md,
// Readings to confirm with the founder: R10).
//
// The locks follow the lock order (event-sequence.ts): the change set's row,
// then the rows of its requests that get a revision, in the order of their
// ids, then their pending proposals, then the teams' next request numbers, in
// the order of the teams' ids, all before the update's first event.

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

/** A request of the change set: the team it was opened to, and its state now. */
interface ChangeSetRequest {
  requestId: string;
  teamId: string;
  state: RequestState;
}

/** The requests the change set's updates opened, oldest first. */
async function requestsOfChangeSet({ tx, orgId }: OrgContext, changeSetId: string): Promise<ChangeSetRequest[]> {
  const rows = await tx
    .select({ requestId: contractChangeRequests.requestId, teamId: contractChangeRequests.teamId, state: requests.state })
    .from(contractChangeRequests)
    .innerJoin(requests, and(eq(requests.orgId, contractChangeRequests.orgId), eq(requests.id, contractChangeRequests.requestId)))
    .where(and(eq(contractChangeRequests.orgId, orgId), eq(contractChangeRequests.changeSetId, changeSetId)))
    .orderBy(asc(contractChangeRequests.openedAt), asc(contractChangeRequests.requestId));
  return rows.map((row) => ({ ...row, state: row.state as RequestState }));
}

/** "1 X" or "N Xs". */
function counted(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`;
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
  const toRevise = report === undefined ? [] : existing.filter(({ state }) => !isTerminalState(state)).sort(byId(({ requestId }) => requestId));
  const opening = current.changes.some(({ level }) => level === "ERR");
  const candidates = opening ? (await consumingTeams(context, changeSet.apiId)).filter(({ id }) => !existing.some(({ teamId }) => teamId === id)) : [];
  const { letIn: toOpen, waiting } = await fanOut(context, changeSet, candidates);
  await recordWaiting(context, changeSet, waiting);
  if (toRevise.length === 0 && toOpen.length === 0) {
    await markApplied();
    return { opened: [] };
  }
  return context.write(async (writer) => {
    // Every lock before the update's first event: the requests' rows, their pending proposals, then the teams' next numbers.
    for (const { requestId } of toRevise) await lockRequestById(writer, requestId);
    for (const { requestId } of toRevise) await lockPendingProposals(writer, requestId);
    const numbers = new Map<string, number>();
    for (const team of [...toOpen].sort(byId(({ id }) => id))) numbers.set(team.id, await takeRequestNumber(writer, team.id));

    for (const { requestId } of toRevise) {
      const currentPacket = (await packetRevisionOf(writer, requestId)).packet as Packet;
      await storePacketRevision(writer, requestId, { ...currentPacket, untrusted: { ...currentPacket.untrusted, contract: section } } as Packet, stampOf(writer.provenance, undefined));
    }
    const opened: string[] = [];
    for (const team of toOpen) {
      const number = numbers.get(team.id) ?? 0;
      const [row] = await writer.tx
        .insert(requests)
        .values({ orgId: writer.orgId, targetTeamId: team.id, number, title: titleOf(section), requestingUserId: null, requestingTeamId: api.providerTeamId })
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
