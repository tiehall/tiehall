import { reportContractChanges } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { contractReports } from "@tiehall/db";
import { reportableApi } from "./apis.ts";
import { defineHandler, type Handlers } from "./execute.ts";

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
// changes no request itself, and so appends no event.

export const CONTRACT_REPORT_HANDLERS: Handlers = {
  [reportContractChanges.id]: defineHandler(reportContractChanges, async (input, context) => {
    const { caller } = context;
    if (caller.kind !== "ci") {
      throw new Refusal("forbidden", "Only a CI run of the contract Action reports contract changes, with its run's GitHub Actions OIDC token.");
    }
    const api = await reportableApi(context, caller, input.api);
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
        receivedAt: context.now(),
      })
      .returning({ id: contractReports.id, receivedAt: contractReports.receivedAt });
    if (row === undefined) throw new Error("A contract report was not stored.");
    return { id: row.id, api: api.name, receivedAt: row.receivedAt.toISOString() };
  }),
};
