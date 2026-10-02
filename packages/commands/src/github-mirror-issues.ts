import { createHash } from "node:crypto";
import { githubApp, githubDeliveries, githubIssueReconciliations, mirrors, type Database } from "@tiehall/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { installationCovering } from "./contract-requesters.ts";
import { polledDeliveryId } from "./github-changes.ts";
import { gitHubUnavailable, GitHubUnavailableError, pagesOf } from "./github-client.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { processGitHubDelivery } from "./github-webhooks.ts";
import type { JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { withOrg, type OrgContext } from "./with-org.ts";

// The mirror issues as Tiehall reads them from GitHub without a delivery
// (tracker-mirrors: Reconciliation catches missed changes; tracker-mirrors:
// Mirror writes are idempotent and never echo; design.md, Design rules:
// Tracker mirrors; design.md, Technical decisions: T16). A delivery about a
// mirror issue can be lost, so the 15-minute reconciliation, in webhook mode
// as in polling mode, asks GitHub, with its `since` parameter, for the issues
// of each repository that holds mirror issues updated since shortly before it
// last read that repository, with the token of the working connected
// installation that covers it now; a repository none covers is not read.
//
// Each mirror issue among them is stored as the change it is, the issue in the
// state GitHub lists it in, in the form of a delivery about it, with the job
// that processes it as a delivery is processed (github-issue-processing.ts):
// as if its webhook had arrived. Issues that mirror no request, and pull
// requests, which GitHub lists among the issues, are left out. A change is
// stored once under its key, so runs that list the same issue in the same
// state hand it on once. A delivery about the same change may come too, and
// is stored on its own; the processing reads the issue from GitHub and records
// only what differs from what Tiehall knows the issue shows, under the
// request's lock (tracker-changes.ts), so the change is recorded once,
// whichever comes first. What Tiehall wrote itself comes back the same way,
// and is dropped there as an echo.
//
// The run records, per repository, when it read it to the end; a repository
// GitHub failed to list, or that no installation covers now, keeps the time of
// its last read, so a later run reads the changes it missed. The first read of
// a repository starts at its first mirror issue. A run that could not read a
// repository fails, after reading the others, so the job is tried again.

/** How far before the last read each read starts: for GitHub's timestamps to the second, a clock that differs from GitHub's, and a change GitHub records while a run reads. */
const OVERLAP_MS = 5 * 60 * 1000;

/** How many issues GitHub gives per page at most, which a listing asks for. */
const PER_PAGE = 100;

const ACCOUNT = z.looseObject({ id: z.number().int().positive(), login: z.string().min(1).max(100) });

const LISTED_ISSUE = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  assignees: z.array(ACCOUNT).nullable().optional(),
  closed_at: z.string().nullable().optional(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});

/** An issue as GitHub lists it, in what Tiehall keeps of it. */
type ListedIssue = z.output<typeof LISTED_ISSUE>;

/** A repository that holds mirror issues, with the installation that covers it now, and the time its first mirror issue was made. */
interface MirrorRepository {
  repositoryId: number;
  fullName: string;
  installationId: number;
  firstIssueAt: Date;
  reconciledAt: Date | undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The key of the change an issue in this state is: its repository and number,
 * and a digest of what the processing reads of it and the time GitHub last
 * changed it, so each change of the issue has its own key and the same
 * listing has the same one.
 */
export function issueChangeKey(repositoryId: number, issue: ListedIssue): string {
  const state = [issue.state, issue.state_reason ?? null, (issue.assignees ?? []).map(({ id }) => id), issue.closed_at ?? null, issue.updated_at];
  return `issues:${repositoryId}:${issue.number}:${digest(JSON.stringify(state)).slice(0, 32)}`;
}

/** The repositories that hold GitHub mirror issues that a working connected installation of the App covers now, with when each was last reconciled. */
async function mirrorRepositories(context: Pick<OrgContext, "tx" | "orgId">, appId: number): Promise<MirrorRepository[]> {
  const { tx, orgId } = context;
  const places = await tx
    .select({ target: mirrors.target, firstIssueAt: sql<Date | null>`min(coalesce(${mirrors.issueCreatedAt}, ${mirrors.createdAt}))`.mapWith(mirrors.createdAt) })
    .from(mirrors)
    .where(and(eq(mirrors.orgId, orgId), eq(mirrors.tracker, "github"), isNotNull(mirrors.issue)))
    .groupBy(mirrors.target)
    .orderBy(mirrors.target);
  const reconciled = new Map(
    (await tx.select().from(githubIssueReconciliations).where(eq(githubIssueReconciliations.orgId, orgId))).map(({ repositoryId, reconciledAt }) => [repositoryId, reconciledAt]),
  );
  const repositories: MirrorRepository[] = [];
  for (const { target, firstIssueAt } of places) {
    const repositoryId = Number(target);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || firstIssueAt === null) continue;
    const covering = await installationCovering(context, appId, repositoryId);
    if (covering === undefined) continue;
    repositories.push({ repositoryId, ...covering, firstIssueAt, reconciledAt: reconciled.get(repositoryId) });
  }
  return repositories;
}

/**
 * The issues of a repository updated at or after `since`, as GitHub lists
 * them with its `since` parameter, less the pull requests among them. It
 * throws GitHubUnavailableError when GitHub fails a page, or answers one with
 * something that is not a list, which says nothing of what changed.
 */
async function issuesUpdatedSince(app: GitHubAppAccess, repository: MirrorRepository, since: Date): Promise<ListedIssue[]> {
  const [owner = "", repo = ""] = repository.fullName.split("/");
  const issues: ListedIssue[] = [];
  try {
    for await (const page of pagesOf(app.client.installation(repository.installationId), "GET /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      state: "all",
      since: since.toISOString(),
      sort: "updated",
      direction: "desc",
      per_page: PER_PAGE,
    })) {
      if (!Array.isArray(page)) throw new GitHubUnavailableError("GitHub's answer to the listing of a repository's issues is not a list.");
      for (const item of page) {
        const issue = LISTED_ISSUE.safeParse(item);
        if (issue.success && issue.data.pull_request === undefined) issues.push(issue.data);
      }
    }
  } catch (error) {
    throw gitHubUnavailable("the listing of a repository's issues", error);
  }
  return issues;
}

/**
 * Stores, in the caller's transaction, each of these issues that is a mirror
 * issue as the change it is, with the job that processes it; returns how
 * many were new.
 */
async function storeIssueChanges(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  jobs: JobSender,
  repository: MirrorRepository,
  issues: readonly ListedIssue[],
): Promise<number> {
  if (issues.length === 0) return 0;
  const mirrored = new Set(
    (
      await tx
        .select({ issue: mirrors.issue })
        .from(mirrors)
        .where(
          and(
            eq(mirrors.orgId, orgId),
            eq(mirrors.tracker, "github"),
            eq(mirrors.target, String(repository.repositoryId)),
            inArray(
              mirrors.issue,
              issues.map(({ number }) => String(number)),
            ),
          ),
        )
    ).map(({ issue }) => issue),
  );
  let stored = 0;
  for (const issue of issues) {
    if (!mirrored.has(String(issue.number))) continue;
    const changeKey = issueChangeKey(repository.repositoryId, issue);
    const deliveryId = polledDeliveryId(changeKey);
    // The input of a delivery about the issue, less the action and the sender, which a listing does not know, and less
    // what the processing does not read, such as the issue's title and body.
    const payload = {
      issue: {
        number: issue.number,
        state: issue.state,
        state_reason: issue.state_reason ?? null,
        assignees: (issue.assignees ?? []).map(({ id, login }) => ({ id, login })),
        closed_at: issue.closed_at ?? null,
        updated_at: issue.updated_at,
      },
      repository: { id: repository.repositoryId, full_name: repository.fullName },
      installation: { id: repository.installationId },
    };
    const inserted = await tx
      .insert(githubDeliveries)
      .values({ orgId, deliveryId, event: "issues", payload, changeKey, enqueuedAt: sql`now()` })
      .onConflictDoNothing()
      .returning({ deliveryId: githubDeliveries.deliveryId });
    if (inserted.length === 0) continue;
    await jobs.send(tx, processGitHubDelivery.type.queue, { deliveryId });
    stored += 1;
  }
  return stored;
}

export interface MirrorIssueReconciliationOptions {
  /** The app's database, as the app role; setup must be complete. */
  database: Database;
  app: GitHubAppAccess;
  /** Sends the processing job of each change found, in the transaction that stores it. */
  jobs: JobSender;
  now: () => Date;
  logger?: Logger;
}

/**
 * The reconciliation's read of the mirror issues: hands on each change of a
 * mirror issue made since shortly before the last read of its repository, and
 * returns how many it handed on. It throws, after reading every repository it
 * could, when GitHub failed one.
 */
export async function reconcileMirrorIssues(options: MirrorIssueReconciliationOptions): Promise<number> {
  const { database, app, jobs } = options;
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const started = options.now();
  const repositories = await withOrg(
    database,
    async (context) => {
      const [current] = await context.tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, context.orgId));
      return current?.appId === app.appId ? mirrorRepositories(context, app.appId) : [];
    },
    { readOnly: true },
  );
  let failure: unknown;
  let found = 0;
  for (const repository of repositories) {
    const since = new Date((repository.reconciledAt ?? repository.firstIssueAt).getTime() - OVERLAP_MS);
    let issues: ListedIssue[];
    try {
      issues = await issuesUpdatedSince(app, repository, since);
    } catch (error) {
      logger.warn("github: GitHub did not list the issues of a repository that holds mirror issues", { repositoryId: repository.repositoryId, error });
      failure ??= error;
      continue;
    }
    found += await withOrg(database, async (context) => {
      const stored = await storeIssueChanges(context, jobs, repository, issues);
      await context.tx
        .insert(githubIssueReconciliations)
        .values({ orgId: context.orgId, repositoryId: repository.repositoryId, reconciledAt: started })
        .onConflictDoUpdate({ target: [githubIssueReconciliations.orgId, githubIssueReconciliations.repositoryId], set: { reconciledAt: started } });
      return stored;
    });
  }
  if (found > 0) logger.info("github: the reconciliation found changes of mirror issues", { changes: found });
  // A repository that could not be read is read again from the same time at the next run.
  if (failure !== undefined) throw failure;
  return found;
}
