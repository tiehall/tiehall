import { applyChangeSet, packet as packetSchema, type ContractSection, type Packet } from "@tiehall/catalog";
import { formatRequestKey, Refusal, requestOpened } from "@tiehall/core";
import { apiConsumers, apis, contractChangeRequests, contractChangeSets, contractReports, requests, teams } from "@tiehall/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { insertPacketRevision } from "./packet-revisions.ts";
import { stampOf } from "./request-changes.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import type { OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// Contract-change routing (contract-changes: Breaking changes open one request
// per consuming team; contract-changes: INFO-level changes appear only on
// existing requests; requests: System actions need no proposal or
// confirmation; requests: Provenance is stamped by the server; design.md,
// Decisions this change rests on: D14, D15; D28 #70, #71; D30 (3); design.md,
// Design rules: Contract changes).
//
// A change set is one provider pull request against one registered API: the
// reports of CI runs for that API about that pull request, in the repository
// the API is bound to. contract.report stores each report with its change
// set, which it makes on the change set's first report, and starts the job
// that applies the change set's update, in the report's transaction. The job
// runs the internal system command contract.apply_change_set as a system job
// from GitHub, so what it changes takes effect with no proposal and no
// confirmation and is recorded with the actor kind system and the surface
// github. The command locks the change set's row, so the updates of one
// change set take turns, and applies the change set's latest report, unless
// an update applied it already:
// - the changes that open requests are the report's ERR-level ones;
// - when there are some, each team that declared it consumes the API, while
//   the API is registered, and has no request for the change set gets one:
//   addressed to the team, from the API's provider team, with a title and a
//   need in Tiehall's words, and a packet of the kind contract_change whose
//   contract section carries the report's API, refs and SHAs, engine, provider
//   pull request, and every classified change with its level, ERR, WARN and
//   INFO alike, so INFO-level changes appear only in the change lists of the
//   requests other changes opened;
// - a report with no ERR-level change opens nothing, whatever it holds.
// The requests a report opens are not held to the target team's required
// fields, which apply to the requests people and agents open (design.md,
// Readings to confirm with the founder: R10).
//
// The locks follow the lock order (event-sequence.ts): the change set's row,
// then the teams' next request numbers, in the order of the teams' ids, all
// before the update's first event.

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
}

/** The change set's row, locked until the call's transaction ends; 404 when there is none. */
async function lockChangeSet({ tx, orgId }: OrgContext, changeSetId: string) {
  const [row] = await tx
    .select({
      id: contractChangeSets.id,
      apiId: contractChangeSets.apiId,
      pullRequestNumber: contractChangeSets.pullRequestNumber,
      repositoryId: contractChangeSets.repositoryId,
      appliedReportId: contractChangeSets.appliedReportId,
    })
    .from(contractChangeSets)
    .where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.id, changeSetId)))
    .for("update");
  if (row === undefined) throw new Refusal("record-not-found", "There is no such change set.");
  return row;
}

/** The change set's latest report: the last one received, by its time and then its id. */
async function latestReport({ tx, orgId }: OrgContext, changeSet: { apiId: string; repositoryId: number; pullRequestNumber: number }): Promise<StoredReport | undefined> {
  const [row] = await tx
    .select({
      id: contractReports.id,
      pullRequestNumber: contractReports.pullRequestNumber,
      baseRef: contractReports.baseRef,
      baseSha: contractReports.baseSha,
      headRef: contractReports.headRef,
      headSha: contractReports.headSha,
      engineName: contractReports.engineName,
      engineVersion: contractReports.engineVersion,
      changes: contractReports.changes,
    })
    .from(contractReports)
    .where(
      and(
        eq(contractReports.orgId, orgId),
        eq(contractReports.apiId, changeSet.apiId),
        eq(contractReports.repositoryId, changeSet.repositoryId),
        eq(contractReports.pullRequestNumber, changeSet.pullRequestNumber),
      ),
    )
    .orderBy(desc(contractReports.receivedAt), desc(contractReports.id))
    .limit(1);
  return row === undefined ? undefined : { ...row, changes: row.changes as ContractSection["changes"] };
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

/** The requests the change set's updates opened, by the team each was opened to. */
async function requestsOfChangeSet({ tx, orgId }: OrgContext, changeSetId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ teamId: contractChangeRequests.teamId, requestId: contractChangeRequests.requestId })
    .from(contractChangeRequests)
    .where(and(eq(contractChangeRequests.orgId, orgId), eq(contractChangeRequests.changeSetId, changeSetId)))
    .orderBy(asc(contractChangeRequests.openedAt));
  return new Map(rows.map(({ teamId, requestId }) => [teamId, requestId]));
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

/** Applies a change set's latest report, as contract.apply_change_set does; returns the keys of the requests it opened. */
async function applyUpdate(context: HandlerContext, changeSetId: string): Promise<{ opened: string[] }> {
  const changeSet = await lockChangeSet(context, changeSetId);
  const report = await latestReport(context, changeSet);
  if (report === undefined || report.id === changeSet.appliedReportId) return { opened: [] };
  const [api] = await context.tx
    .select({ name: apis.name, providerTeamId: apis.providerTeamId, repositoryFullName: apis.repositoryFullName })
    .from(apis)
    .where(and(eq(apis.orgId, context.orgId), eq(apis.id, changeSet.apiId)));
  if (api === undefined) throw new Error("A change set names an API the install does not have.");
  const markApplied = () =>
    context.tx
      .update(contractChangeSets)
      .set({ appliedReportId: report.id })
      .where(and(eq(contractChangeSets.orgId, context.orgId), eq(contractChangeSets.id, changeSet.id)));

  const opening = report.changes.some(({ level }) => level === "ERR");
  const existing = await requestsOfChangeSet(context, changeSet.id);
  const toOpen = opening ? (await consumingTeams(context, changeSet.apiId)).filter(({ id }) => !existing.has(id)) : [];
  if (toOpen.length === 0) {
    await markApplied();
    return { opened: [] };
  }
  const section = contractSectionOf(report, api);
  return context.write(async (writer) => {
    // Every team's next number before the update's first event, in the order of the teams' ids.
    const numbers = new Map<string, number>();
    for (const team of [...toOpen].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) numbers.set(team.id, await takeRequestNumber(writer, team.id));
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
