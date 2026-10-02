import { applyProviderPullRequest } from "@tiehall/catalog";
import { z } from "zod";
import { installationCovering } from "./contract-requesters.ts";
import type { GitHubEventProcessor } from "./github-delivery-processing.ts";
import { readPullRequest } from "./github-pull-requests.ts";
import { withOrg } from "./with-org.ts";

// The processor of pull request deliveries (tracker-mirrors: GitHub webhooks
// are verified, deduplicated and processed in the background; tracker-mirrors:
// GitHub and Jira each run in webhook mode or polling mode; tracker-mirrors:
// Covered repositories follow each connected installation; contract-changes:
// Requests are withdrawn when the provider PR closes unmerged; design.md,
// Technical decisions: T16; design.md, Self-hosting decisions: S9). A
// `pull_request` delivery from a connected installation, and a pull request
// the poll of polling mode found, which it stores in the same form, come here.
// Tiehall acts only on a pull request of a repository that a connected
// installation of the App covers now, and, as for every delivery, not on what
// the payload says happened: it reads the pull request from GitHub with that
// installation's token, and acts on its state now, so a replayed, redelivered
// or late delivery changes nothing that the current state does not call for.
// GitHub failing that read fails the processing, which the delivery's job
// retries; a pull request GitHub no longer knows changes nothing.
//
// What it does with the pull request: as a provider pull request of contract
// change sets, it runs contract.apply_provider_pull_request as the system from
// GitHub (provider-pull-requests.ts).

const PAYLOAD = z.looseObject({
  repository: z.looseObject({ id: z.number().int().positive() }),
  pull_request: z.looseObject({ number: z.number().int().positive() }),
});

export const processPullRequestEvent: GitHubEventProcessor = async (event, context) => {
  const payload = PAYLOAD.safeParse(event.payload);
  if (!payload.success) return;
  const repositoryId = payload.data.repository.id;
  const number = payload.data.pull_request.number;
  const covering = await withOrg(context.database, (orgContext) => installationCovering(orgContext, context.app.appId, repositoryId), { readOnly: true });
  if (covering === undefined) return;
  const pullRequest = await readPullRequest(context.app.client, covering.installationId, covering.fullName, number);
  if (pullRequest === undefined) return;
  await context.runAsSystem(applyProviderPullRequest.id, { repositoryId, number, state: pullRequest.state, merged: pullRequest.mergedAt !== null });
};
