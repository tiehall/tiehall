import { githubApp, githubConnectedInstallations, githubCoveredRepositories, githubDeliveries, githubInstallations, type Database } from "@tiehall/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { polledDeliveryId, pullRequestChangeKey } from "./github-changes.ts";
import { GitHubUnavailableError, pagesOf, type GitHubClient } from "./github-client.ts";
import { readInstallations, type GitHubAppAccess } from "./github-installations.ts";
import { pollMirrorIssues } from "./github-mirror-issues.ts";
import { processGitHubDelivery } from "./github-webhooks.ts";
import { defineJobType, type JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { checkDepartures } from "./organization-departures.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// Polling mode (tracker-mirrors: GitHub and Jira each run in webhook mode or
// polling mode; tracker-mirrors: Covered repositories follow each connected
// installation; sign-in: Leaving the GitHub organization ends access;
// github-app-reachability: design.md, Design rules: Finding installations;
// design.md, Self-hosting decisions: S9). While GitHub runs in polling mode, a
// job every 60 seconds asks GitHub what changed, so a change is picked up
// within 2 minutes. Each poll:
// - lists the App's installations with the App's own token and reads the
//   repositories of each connected one that is neither suspended nor deleted,
//   so an installation, a change of its repositories, a suspension or a
//   deletion counts with no delivery (github-installations.ts);
// - reads the pull requests of each covered repository that were updated
//   since shortly before the previous poll, newest first, with that
//   repository's installation token, and stores each as the change it is
//   (github-changes.ts), in the same form as a delivery about it, with a job
//   that processes it as a delivery is processed: the same processing, with
//   the same input, as the integration-event caller. A change the poll or a
//   delivery stored already is not stored again, so it is handled once;
// - reads the issues of each repository that holds mirror issues updated
//   since then too, newest first, and stores each mirror issue among them as
//   the change it is, with the job that processes it as a delivery about it
//   is processed (github-mirror-issues.ts; tracker-mirrors: GitHub and Jira
//   each run in webhook mode or polling mode), so a close, a reopen or new
//   assignees made on GitHub are recorded within 2 minutes;
// - checks every member Tiehall saw in an organization against the member
//   list of each working connected organization, and removes those GitHub
//   positively reports gone, as the system (organization-departures.ts),
//   which the `organization` event would otherwise have started.
// Every read is a conditional request (github-client.ts): an unchanged answer
// is a 304, which does not count against GitHub's rate limit. The pull
// requests linked to open requests are among those it reads when their
// repository is covered, and a pull request of a repository no connected
// installation covers closes no request (close-on-merge.ts), so it reads
// none there. A poll that could not read a
// repository keeps the previous poll's time, so the next one reads that
// repository's changes again. In webhook mode the poll does nothing.

/** How far before the previous poll each poll reads, for GitHub's timestamps to the second and a clock that differs from GitHub's. */
const OVERLAP_MS = 2 * 60 * 1000;

/** How many pull requests GitHub gives per page at most, which the poll asks for. */
const PER_PAGE = 100;

const PULL_REQUEST = z.looseObject({ number: z.number().int().positive(), updated_at: z.iso.datetime({ offset: true }) });

/** A covered repository, with the GitHub installation whose token reads it. */
interface PolledRepository {
  repositoryId: number;
  fullName: string;
  installationId: number;
}

export interface PollOptions {
  /** The app's database, as the app role; setup must be complete. */
  database: Database;
  app: GitHubAppAccess;
  /** Sends the processing job of each change found, in the transaction that stores it. */
  jobs: JobSender;
  now: () => Date;
  logger?: Logger;
}

/** The repositories the install covers, with the GitHub id of the installation that covers each, in the order of their names. */
async function repositoriesToPoll({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, appId: number): Promise<PolledRepository[]> {
  return tx
    .selectDistinctOn([githubCoveredRepositories.repositoryId], {
      repositoryId: githubCoveredRepositories.repositoryId,
      fullName: githubCoveredRepositories.fullName,
      installationId: githubInstallations.installationId,
    })
    .from(githubCoveredRepositories)
    .innerJoin(
      githubConnectedInstallations,
      and(
        eq(githubConnectedInstallations.orgId, githubCoveredRepositories.orgId),
        eq(githubConnectedInstallations.installationId, githubCoveredRepositories.installationId),
      ),
    )
    .innerJoin(
      githubInstallations,
      and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)),
    )
    .where(
      and(
        eq(githubCoveredRepositories.orgId, orgId),
        eq(githubInstallations.appId, appId),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubCoveredRepositories.repositoryId), asc(githubInstallations.installationId));
}

/**
 * The pull requests of a repository updated at or after `since`, newest
 * first, as GitHub lists them. It throws GitHubUnavailableError when a page
 * GitHub answers with is not a list, such as a page a proxy serves for GitHub,
 * which says nothing of what changed.
 */
async function pullRequestsUpdatedSince(client: GitHubClient, repository: PolledRepository, since: Date): Promise<Record<string, unknown>[]> {
  const [owner = "", repo = ""] = repository.fullName.split("/");
  const updated: Record<string, unknown>[] = [];
  const pages = pagesOf(client.installation(repository.installationId), "GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: PER_PAGE,
  });
  for await (const page of pages) {
    if (!Array.isArray(page)) throw new GitHubUnavailableError("GitHub's answer to the listing of a repository's pull requests is not a list.");
    let older = false;
    for (const item of page) {
      const parsed = PULL_REQUEST.safeParse(item);
      if (!parsed.success) continue;
      if (Date.parse(parsed.data.updated_at) < since.getTime()) {
        older = true;
        break;
      }
      updated.push(item as Record<string, unknown>);
    }
    // Newest first, so the rest are older.
    if (older) break;
  }
  return updated;
}

/**
 * Stores the pull requests a poll found as changes, in the caller's
 * transaction, each with the job that processes it; returns how many were new.
 */
async function storePullRequestChanges(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  jobs: JobSender,
  repository: PolledRepository,
  pullRequests: readonly Record<string, unknown>[],
): Promise<number> {
  let stored = 0;
  for (const pullRequest of pullRequests) {
    const changeKey = pullRequestChangeKey(repository.repositoryId, pullRequest);
    if (changeKey === undefined) continue;
    const deliveryId = polledDeliveryId(changeKey);
    // The same input as a delivery about the pull request, less the action, which a poll does not know.
    const payload = {
      pull_request: pullRequest,
      repository: { id: repository.repositoryId, full_name: repository.fullName },
      installation: { id: repository.installationId },
    };
    const inserted = await tx
      .insert(githubDeliveries)
      .values({ orgId, deliveryId, event: "pull_request", payload, changeKey, enqueuedAt: sql`now()` })
      .onConflictDoNothing()
      .returning({ deliveryId: githubDeliveries.deliveryId });
    if (inserted.length === 0) continue;
    await jobs.send(tx, processGitHubDelivery.type.queue, { deliveryId });
    stored += 1;
  }
  return stored;
}

/** One poll, in polling mode; returns whether it polled, which it does not in webhook mode. */
export async function pollGitHubChanges(options: PollOptions): Promise<boolean> {
  const { database, app, jobs } = options;
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const started = options.now();
  const state = await withOrg(database, async ({ tx, orgId }) => {
    const [row] = await tx.select({ appId: githubApp.appId, mode: githubApp.mode, polledAt: githubApp.polledAt }).from(githubApp).where(eq(githubApp.orgId, orgId));
    return row;
  });
  if (state === undefined || state.appId !== app.appId || state.mode !== "polling") return false;

  await readInstallations({ database, app, jobs, logger });

  const since = new Date((state.polledAt ?? started).getTime() - OVERLAP_MS);
  const repositories = await withOrg(database, (context) => repositoriesToPoll(context, app.appId), { readOnly: true });
  let failure: unknown;
  let found = 0;
  for (const repository of repositories) {
    let pullRequests: Record<string, unknown>[];
    try {
      pullRequests = await pullRequestsUpdatedSince(app.client, repository, since);
    } catch (error) {
      logger.warn("github: GitHub did not list a covered repository's pull requests", { repositoryId: repository.repositoryId, error });
      failure ??= error;
      continue;
    }
    if (pullRequests.length > 0) found += await withOrg(database, (context) => storePullRequestChanges(context, jobs, repository, pullRequests));
  }

  const mirrored = await pollMirrorIssues({ database, app, jobs, since, logger });
  found += mirrored.found;
  failure ??= mirrored.failure;

  await checkDepartures({ database, app, logger, provenance: { actorKind: "system" } }, { every: true });

  // A repository that could not be read is read again from the same time at the next poll.
  if (failure !== undefined) throw failure;
  await withOrg(database, ({ tx, orgId }) =>
    tx
      .update(githubApp)
      .set({ polledAt: started })
      .where(and(eq(githubApp.orgId, orgId), eq(githubApp.appId, app.appId))),
  );
  if (found > 0) logger.info("github: the poll found changes", { changes: found });
  return true;
}

/** The job that polls GitHub every 60 seconds while GitHub runs in polling mode. */
export const pollGitHub: WorkerJob<Record<string, never>> = {
  // The next poll, a minute later, does the work of one that failed.
  type: defineJobType<Record<string, never>>("github.poll", 1, {
    retryLimit: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    expireInSeconds: 120,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, github, jobs, now }) {
    if (github === undefined || jobs === undefined) throw new Error("The worker gives this job no GitHub App or job queue to poll with.");
    const app = await github.app();
    if (app === undefined) return;
    try {
      await pollGitHubChanges({ database, app, jobs, now });
    } catch (error) {
      // Before setup completes nothing is polled; the first poll comes once it completes.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
