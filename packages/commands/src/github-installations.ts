import type { Octokit } from "@octokit/core";
import { githubConnectedInstallations, githubCoveredRepositories, githubInstallations, type Database } from "@tiehall/db";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { GitHubClient } from "./github-client.ts";
import { defineJobType } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The installations of the install's GitHub App and the repositories they
// cover, found by listing them (github-app-reachability: design.md, Design
// rules: Finding installations, and Technical decisions: T5; tracker-mirrors:
// Admins connect GitHub installations with the confirmation step;
// tracker-mirrors: Covered repositories follow each connected installation).
// Tiehall never needs a delivery to learn of an installation: it lists the
// App's installations with the App's own token (GET /app/installations, 100
// at a time, following GitHub's Link header), whether or not the App has a
// webhook, and keeps them in the table of known installations; an
// installation that a listing no longer holds was deleted on GitHub. It reads
// the repositories of each connected installation that is neither suspended
// nor deleted with that installation's own token (GET
// /installation/repositories, page by page), and those are the repositories
// the install covers. An installation that is not connected is only listed:
// none of its repositories is read or counts as covered.
//
// A listing runs when the sign-in that completes setup arrives, when an admin
// connects an installation (a job, which reads that installation's
// repositories at once), and when a delivery about an installation arrives in
// webhook mode; the poll of polling mode and the 15-minute reconciliation run
// it too, once they are built (tasks 10.8 and 10.9 of add-tiehall-oss-v1).

/** One installation of the App, as GitHub's listing gives it. */
export interface ListedInstallation {
  /** GitHub's numeric id of the installation. */
  installationId: number;
  account: { id: number; login: string; type: "Organization" | "User" };
  repositorySelection: "all" | "selected";
  /** When GitHub suspended it, as GitHub gives it; null while it is not suspended. */
  suspendedAt: string | null;
}

/** One repository an installation covers, as GitHub gives it. */
export interface ListedRepository {
  /** GitHub's numeric id of the repository. */
  id: number;
  fullName: string;
}

/** An installation of the App as Tiehall knows it, for the admin page and the syncs. */
export interface KnownInstallation {
  /** Tiehall's id of the installation, which its events name. */
  id: string;
  /** GitHub's numeric id of the App it belongs to. */
  appId: number;
  /** GitHub's numeric id of the installation. */
  installationId: number;
  account: { id: number; login: string; type: "Organization" | "User" };
  repositorySelection: "all" | "selected";
  suspended: boolean;
  /** A listing no longer held it: it was deleted on GitHub. */
  deleted: boolean;
  connected: boolean;
}

/** A repository the install covers: one a connected installation that is neither suspended nor deleted holds. */
export interface CoveredRepository {
  /** Tiehall's id of the installation that covers it. */
  installationId: string;
  /** GitHub's numeric id of the repository. */
  repositoryId: number;
  fullName: string;
}

/** The install's App, and a client that calls GitHub as it. */
export interface GitHubAppAccess {
  /** GitHub's numeric id of the App. */
  appId: number;
  client: GitHubClient;
}

/** How many items GitHub gives per page at most, which every listing asks for. */
const PER_PAGE = 100;

const INSTALLATION = z.object({
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive(), login: z.string().min(1), type: z.enum(["Organization", "User"]) }),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().nullable().optional(),
});

const REPOSITORIES = z.object({
  repositories: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().min(1) })),
});

/** The URL GitHub's Link header names as the next page, or undefined on the last page. */
function nextPage(link: string | undefined): string | undefined {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) return match[1];
  }
  return undefined;
}

/** Every page of a GitHub listing, the first asked for with these parameters and the rest by the Link header. */
async function everyPage(octokit: Octokit, route: string, parameters: Record<string, unknown>): Promise<unknown[]> {
  const pages: unknown[] = [];
  let response = await octokit.request(route, parameters);
  pages.push(response.data);
  for (let next = nextPage(response.headers.link); next !== undefined; next = nextPage(response.headers.link)) {
    response = await octokit.request(`GET ${next}`);
    pages.push(response.data);
  }
  return pages;
}

/** Lists every installation of the App, with the App's own token, 100 at a time. */
export async function listAppInstallations(client: GitHubClient, logger: Logger = createLogger()): Promise<ListedInstallation[]> {
  const pages = await everyPage(client.app(), "GET /app/installations", { per_page: PER_PAGE });
  const listed: ListedInstallation[] = [];
  for (const item of pages.flatMap((page) => (Array.isArray(page) ? page : []))) {
    const parsed = INSTALLATION.safeParse(item);
    // An installation on an account that is neither a user nor an organization, such as an enterprise, is none Tiehall acts on.
    if (!parsed.success) {
      logger.warn("github: an installation GitHub listed is not on a user or an organization, so it is left out");
      continue;
    }
    const { id, account, repository_selection: repositorySelection, suspended_at: suspendedAt } = parsed.data;
    listed.push({ installationId: id, account: { id: account.id, login: account.login, type: account.type }, repositorySelection, suspendedAt: suspendedAt ?? null });
  }
  return listed;
}

/** Lists every repository an installation covers, with that installation's own token, 100 at a time. */
export async function listInstallationRepositories(client: GitHubClient, installationId: number): Promise<ListedRepository[]> {
  const pages = await everyPage(client.installation(installationId), "GET /installation/repositories", { per_page: PER_PAGE });
  return pages.flatMap((page) => REPOSITORIES.parse(page).repositories.map(({ id, full_name: fullName }) => ({ id, fullName })));
}

/**
 * Records the App's installations as a listing found them, in the caller's
 * transaction: each one it holds is known, with its account, selection and
 * suspension; each known installation of the App that it no longer holds was
 * deleted on GitHub.
 */
export async function recordInstallations({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, appId: number, listed: readonly ListedInstallation[]): Promise<void> {
  for (const installation of listed) {
    const values = {
      appId,
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repositorySelection,
      suspendedAt: installation.suspendedAt === null ? null : new Date(installation.suspendedAt),
    };
    await tx
      .insert(githubInstallations)
      .values({ orgId, installationId: installation.installationId, ...values })
      .onConflictDoUpdate({
        target: [githubInstallations.orgId, githubInstallations.installationId],
        set: { ...values, deletedAt: null, listedAt: sql`now()` },
      });
  }
  const held = listed.map(({ installationId }) => installationId);
  await tx
    .update(githubInstallations)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.appId, appId),
        isNull(githubInstallations.deletedAt),
        ...(held.length === 0 ? [] : [notInArray(githubInstallations.installationId, held)]),
      ),
    );
}

/** Connects these known installations, by Tiehall's ids, in the caller's transaction; returns those that were not connected before. */
export async function connectInstallations({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const connected = await tx
    .insert(githubConnectedInstallations)
    .values(ids.map((installationId) => ({ orgId, installationId })))
    .onConflictDoNothing()
    .returning({ installationId: githubConnectedInstallations.installationId });
  return connected.map(({ installationId }) => installationId);
}

/** Replaces the repositories a connected installation covers with those just read, in the caller's transaction. */
export async function recordCoveredRepositories(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  installationId: string,
  repositories: readonly ListedRepository[],
): Promise<void> {
  await tx
    .delete(githubCoveredRepositories)
    .where(and(eq(githubCoveredRepositories.orgId, orgId), eq(githubCoveredRepositories.installationId, installationId)));
  if (repositories.length === 0) return;
  await tx
    .insert(githubCoveredRepositories)
    .values(repositories.map(({ id, fullName }) => ({ orgId, installationId, repositoryId: id, fullName })))
    .onConflictDoNothing();
}

/** Every installation Tiehall knows, of any App, by account login and then by GitHub's id. */
export async function knownInstallations({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<KnownInstallation[]> {
  const rows = await tx
    .select({
      id: githubInstallations.id,
      appId: githubInstallations.appId,
      installationId: githubInstallations.installationId,
      accountId: githubInstallations.accountId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      repositorySelection: githubInstallations.repositorySelection,
      suspendedAt: githubInstallations.suspendedAt,
      deletedAt: githubInstallations.deletedAt,
      connectedAt: githubConnectedInstallations.connectedAt,
    })
    .from(githubInstallations)
    .leftJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
    )
    .where(eq(githubInstallations.orgId, orgId))
    .orderBy(asc(githubInstallations.accountLogin), asc(githubInstallations.installationId));
  return rows.map((row) => ({
    id: row.id,
    appId: row.appId,
    installationId: row.installationId,
    account: { id: row.accountId, login: row.accountLogin, type: row.accountType === "Organization" ? "Organization" : "User" },
    repositorySelection: row.repositorySelection === "all" ? "all" : "selected",
    suspended: row.suspendedAt !== null,
    deleted: row.deletedAt !== null,
    connected: row.connectedAt !== null,
  }));
}

/** The repositories the install covers now: those of its connected installations that are neither suspended nor deleted. */
export async function coveredRepositories({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<CoveredRepository[]> {
  return tx
    .select({
      installationId: githubCoveredRepositories.installationId,
      repositoryId: githubCoveredRepositories.repositoryId,
      fullName: githubCoveredRepositories.fullName,
    })
    .from(githubCoveredRepositories)
    .innerJoin(
      githubInstallations,
      and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)),
    )
    .where(and(eq(githubCoveredRepositories.orgId, orgId), isNull(githubInstallations.suspendedAt), isNull(githubInstallations.deletedAt)))
    .orderBy(asc(githubCoveredRepositories.fullName), asc(githubCoveredRepositories.repositoryId));
}

/**
 * The connected installation that covers a repository, by the repository's
 * GitHub id, which a rename keeps: Tiehall's id of the installation and
 * GitHub's; undefined when no connected installation that is neither
 * suspended nor deleted covers it. The merged-PR rules, the mirrors and the
 * provider PRs ask it.
 */
export async function coveringInstallation(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  repositoryId: number,
): Promise<{ installation: string; installationId: number } | undefined> {
  const [row] = await tx
    .select({ installation: githubInstallations.id, installationId: githubInstallations.installationId })
    .from(githubCoveredRepositories)
    .innerJoin(
      githubInstallations,
      and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)),
    )
    .where(
      and(
        eq(githubCoveredRepositories.orgId, orgId),
        eq(githubCoveredRepositories.repositoryId, repositoryId),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubInstallations.installationId))
    .limit(1);
  return row;
}

/** The connected installations of the App whose repositories are read: those neither suspended nor deleted. */
async function liveConnectedInstallations(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  appId: number,
  only?: readonly number[],
): Promise<{ id: string; installationId: number }[]> {
  return tx
    .select({ id: githubInstallations.id, installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
    )
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.appId, appId),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
        ...(only === undefined ? [] : only.length === 0 ? [sql`false`] : [inArray(githubInstallations.installationId, [...only])]),
      ),
    )
    .orderBy(asc(githubInstallations.installationId));
}

/** Reads the repositories of these installations from GitHub, outside any transaction. */
export async function readRepositoriesOf(
  client: GitHubClient,
  installations: readonly { id: string; installationId: number }[],
): Promise<Map<string, ListedRepository[]>> {
  const read = new Map<string, ListedRepository[]>();
  for (const { id, installationId } of installations) read.set(id, await listInstallationRepositories(client, installationId));
  return read;
}

export interface ReadInstallationsOptions {
  /** The app's database, as the app role; setup must be complete. */
  database: Database;
  app: GitHubAppAccess;
  /** Reads the repositories of these connected installations only, by GitHub's ids; of every connected one by default. */
  repositoriesOf?: readonly number[];
  logger?: Logger;
}

/**
 * Lists the App's installations and records them, then reads the repositories
 * of its connected installations that are neither suspended nor deleted and
 * records those, each step in its own transaction and every call to GitHub
 * outside one.
 */
export async function readInstallations(options: ReadInstallationsOptions): Promise<void> {
  const { database, app } = options;
  const listed = await listAppInstallations(app.client, options.logger);
  const toRead = await withOrg(database, async (context) => {
    await recordInstallations(context, app.appId, listed);
    return liveConnectedInstallations(context, app.appId, options.repositoriesOf);
  });
  const repositories = await readRepositoriesOf(app.client, toRead);
  await withOrg(database, async (context) => {
    // Recorded only for installations still connected and live: an admin may have disconnected one meanwhile.
    const still = new Set((await liveConnectedInstallations(context, app.appId)).map(({ id }) => id));
    for (const [installationId, read] of repositories) if (still.has(installationId)) await recordCoveredRepositories(context, installationId, read);
  });
}

/**
 * A job that lists the App's installations and reads the repositories of the
 * connected ones, or of those it names, by GitHub's ids: sent when an admin
 * connects an installation, so its repositories count as covered at once.
 */
export const syncGitHubInstallations: WorkerJob<{ repositoriesOf?: number[] }> = {
  // Five attempts over about an hour, then the dead-letter queue, as for every integration job (design.md, Decisions this change rests on: D28 #83).
  type: defineJobType<{ repositoriesOf?: number[] }>("github.sync_installations", 1, {
    retryLimit: 4,
    retryDelaySeconds: 240,
    retryBackoff: true,
    expireInSeconds: 300,
  }),
  async handle(job, { database, github }) {
    if (github === undefined) throw new Error("The worker gives this job no GitHub App to list the installations of.");
    const app = await github.app();
    if (app === undefined) return;
    try {
      await readInstallations({ database, app, ...(job.data.repositoriesOf === undefined ? {} : { repositoriesOf: job.data.repositoriesOf }) });
    } catch (error) {
      // Before setup completes there is nothing to sync; the sign-in that completes it lists the installations.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
