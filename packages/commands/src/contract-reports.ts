import { reportContractChanges } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { contractChangeSets, contractReports, teams } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { reportableApi } from "./apis.ts";
import { authorUnavailable, installationCovering, pullRequestAuthor, requestingUserOf } from "./contract-requesters.ts";
import { applyChangeSets, burstEnd } from "./contract-routing.ts";
import { definePreparedHandler, type Handlers, type PrepareContext } from "./execute.ts";
import { GitHubUnavailableError } from "./github-client.ts";

// Taking contract reports (contract-changes: One report operation that never
// takes a whole spec; contract-changes: Admins register APIs, each bound to
// one repository; agent-access: CI authenticates with GitHub Actions OIDC
// bound to registered repositories; agent-access: OAuth scopes are coarse).
// contract.report accepts the CI caller alone: a call made for a user, with a
// personal access token or an OAuth token, whatever scopes it carries, is
// refused with 403, as the error model gives a caller whose part does not
// allow the action. A CI run may report only for an API registered to its
// repository and, for an API bound to a workflow, from that workflow
// (apis.ts), and is refused with 403 otherwise. An accepted report is stored
// as it was sent, with the run's repository, owner and workflow as its OIDC
// token named them, in the call's transaction, for routing to read; it
// changes no request itself, and so appends no event. The report joins its
// change set, the pull request against the API, which its first report makes,
// and the burst of reports its next update merges (contract-routing.ts;
// contract-changes: Bursts of reports are merged into one update): a report
// while no burst waits starts one and, in the same transaction, the worker's
// job that applies its update 2 minutes later, so the job runs only once the
// report has committed; a report within those 2 minutes joins the burst; and a
// report that comes once they are over while the update has not been applied
// yet, such as while the worker was stopped, starts a job at once, whose
// update applies the waiting burst and then starts the next with this report.
// Before the report's transaction, Tiehall reads the provider pull request's
// author from GitHub (contract-requesters.ts), keeps the author's GitHub
// account with the report, and answers who requests the changes of the
// requests the report opens.

/**
 * The provider pull request's author, read from GitHub before the report's
 * transaction (contract-requesters.ts), for a report the run may make: its
 * GitHub account's id, or null when it cannot be known; undefined for a call
 * the handler refuses anyway, which reads nothing from GitHub.
 */
async function authorOf(input: { api: string; pullRequest: { number: number } }, context: PrepareContext): Promise<{ authorGitHubId: number | null } | undefined> {
  const { caller } = context;
  if (caller.kind !== "ci") return undefined;
  const reportable = await context.read(async (orgContext) =>
    reportableApi(orgContext, caller, input.api).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Refusal) return false;
        throw error;
      },
    ),
  );
  if (!reportable) return undefined;
  const app = await context.github?.app();
  if (app === undefined) return { authorGitHubId: null };
  const covering = await context.read((orgContext) => installationCovering(orgContext, app.appId, Number(caller.repositoryId)));
  if (covering === undefined) return { authorGitHubId: null };
  try {
    const author = await pullRequestAuthor(app.client, covering.installationId, covering.fullName, input.pullRequest.number);
    return { authorGitHubId: author?.id ?? null };
  } catch (error) {
    if (error instanceof GitHubUnavailableError) throw authorUnavailable(error);
    throw error;
  }
}

export const CONTRACT_REPORT_HANDLERS: Handlers = {
  [reportContractChanges.id]: definePreparedHandler(reportContractChanges, authorOf, async (input, context) => {
    const { caller } = context;
    if (caller.kind !== "ci") {
      throw new Refusal("forbidden", "Only a CI run of the contract Action reports contract changes, with its run's GitHub Actions OIDC token.");
    }
    const api = await reportableApi(context, caller, input.api);
    const authorGitHubId = context.prepared?.authorGitHubId ?? null;
    const receivedAt = context.now();
    // The change set: made by its first report, and locked by every report until its transaction ends.
    const [changeSet] = await context.tx
      .insert(contractChangeSets)
      .values({ orgId: context.orgId, apiId: api.id, repositoryId: Number(caller.repositoryId), pullRequestNumber: input.pullRequest.number })
      .onConflictDoUpdate({
        target: [contractChangeSets.orgId, contractChangeSets.apiId, contractChangeSets.repositoryId, contractChangeSets.pullRequestNumber],
        set: { pullRequestNumber: input.pullRequest.number },
      })
      .returning({ id: contractChangeSets.id, burstStartedAt: contractChangeSets.burstStartedAt });
    if (changeSet === undefined) throw new Error("A contract report's change set was not stored.");
    const [row] = await context.tx
      .insert(contractReports)
      .values({
        orgId: context.orgId,
        apiId: api.id,
        repositoryId: Number(caller.repositoryId),
        repositoryOwnerId: Number(caller.repositoryOwnerId),
        jobWorkflowRef: caller.jobWorkflowRef,
        pullRequestNumber: input.pullRequest.number,
        baseRef: input.base.ref,
        baseSha: input.base.sha,
        headRef: input.head.ref,
        headSha: input.head.sha,
        engineName: input.engine.name,
        engineVersion: input.engine.version,
        changes: input.changes,
        receivedAt,
        authorGitHubId,
      })
      .returning({ id: contractReports.id, receivedAt: contractReports.receivedAt });
    if (row === undefined) throw new Error("A contract report was not stored.");
    if (changeSet.burstStartedAt === null) {
      // The first report of a burst: its update is applied 2 minutes from now.
      await context.tx
        .update(contractChangeSets)
        .set({ burstStartedAt: receivedAt })
        .where(and(eq(contractChangeSets.orgId, context.orgId), eq(contractChangeSets.id, changeSet.id)));
      await context.enqueue(applyChangeSets.type, { changeSetId: changeSet.id }, { startAfter: burstEnd(receivedAt) });
    } else if (receivedAt.getTime() >= burstEnd(changeSet.burstStartedAt).getTime()) {
      // The waiting burst is over and its update not applied yet: apply it now, which starts the next burst with this report.
      await context.enqueue(applyChangeSets.type, { changeSetId: changeSet.id }, { startAfter: receivedAt });
    }
    const requester = await requestingUserOf(context, authorGitHubId);
    const [provider] = await context.tx.select({ key: teams.key }).from(teams).where(and(eq(teams.orgId, context.orgId), eq(teams.id, api.providerTeamId)));
    if (provider === undefined) throw new Error("A registered API names a provider team the install does not have.");
    return { id: row.id, api: api.name, receivedAt: row.receivedAt.toISOString(), requester: { kind: requester === null ? ("team" as const) : ("author" as const), team: provider.key } };
  }),
};
