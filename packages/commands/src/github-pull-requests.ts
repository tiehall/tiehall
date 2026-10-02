import { githubConnectedInstallations, githubCoveredRepositories, githubInstallations } from "@tiehall/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { gitHubUnavailable, GitHubUnavailableError, statusOfCall, type GitHubClient } from "./github-client.ts";
import type { OrgContext } from "./with-org.ts";

// Reading a pull request from GitHub (tracker-mirrors: The GitHub App asks
// for narrow permissions and every event up front; agent-access: Outbound
// calls use Tiehall's own credentials; design.md, Technical decisions: T16).
// Tiehall reads a pull request of a covered repository with the token of the
// connected installation that covers it, which the App's Pull requests (read)
// permission allows, and acts on what GitHub says of it now: its state,
// whether and when it merged, its author, and the title, body and branch name
// that can mention a request's key. Nothing it reads leaves the processing
// that asked for it.

/** A pull request as GitHub gives it now. */
export interface PullRequestNow {
  number: number;
  state: "open" | "closed";
  /** When it merged, as GitHub gives it, to the second; null while it has not. */
  mergedAt: Date | null;
  /** Its author, by GitHub's id; null when GitHub names none, as for a deleted account. */
  author: { id: number; login: string } | null;
  title: string;
  body: string;
  /** The name of its head branch. */
  headRef: string;
  /** When GitHub last updated it, to the second; null when GitHub gives no such time. */
  updatedAt: Date | null;
}

const PULL_REQUEST = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged_at: z.iso.datetime({ offset: true }).nullable().optional(),
  user: z.object({ id: z.number().int().positive(), login: z.string().min(1) }).nullable(),
  title: z.string(),
  body: z.string().nullable().optional(),
  head: z.object({ ref: z.string() }),
  updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
});

/**
 * A repository's pull request, as GitHub's API gives it now to the
 * installation that covers the repository; undefined when GitHub knows no
 * such pull request. It throws GitHubUnavailableError when GitHub fails the
 * read, does not answer it, or answers with something that is not that pull
 * request.
 */
export async function readPullRequest(client: GitHubClient, installationId: number, fullName: string, number: number): Promise<PullRequestNow | undefined> {
  const [owner = "", repo = ""] = fullName.split("/");
  let data: unknown;
  try {
    ({ data } = await client.installation(installationId).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number }));
  } catch (error) {
    if (statusOfCall(error) === 404) return undefined;
    throw gitHubUnavailable("the read of a pull request", error);
  }
  const parsed = PULL_REQUEST.safeParse(data);
  if (!parsed.success || parsed.data.number !== number) throw new GitHubUnavailableError("GitHub's answer to the read of a pull request names no such pull request.");
  const pr = parsed.data;
  return {
    number: pr.number,
    state: pr.state,
    mergedAt: pr.merged_at === null || pr.merged_at === undefined ? null : new Date(pr.merged_at),
    author: pr.user,
    title: pr.title,
    body: pr.body ?? "",
    headRef: pr.head.ref,
    updatedAt: pr.updated_at === null || pr.updated_at === undefined ? null : new Date(pr.updated_at),
  };
}

/**
 * The connected installation of the App, neither suspended nor deleted, that
 * covers the repository with this owner/name, which GitHub compares without
 * regard to case, and the repository's name as GitHub gave it, with GitHub's
 * id of it; undefined when none does.
 */
export async function installationCoveringNamed(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  appId: number,
  fullName: string,
): Promise<{ installationId: number; fullName: string; repositoryId: number } | undefined> {
  const [row] = await tx
    .select({ installationId: githubInstallations.installationId, fullName: githubCoveredRepositories.fullName, repositoryId: githubCoveredRepositories.repositoryId })
    .from(githubCoveredRepositories)
    .innerJoin(githubInstallations, and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)))
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubCoveredRepositories.orgId), eq(githubConnectedInstallations.installationId, githubCoveredRepositories.installationId)),
    )
    .where(
      and(
        eq(githubCoveredRepositories.orgId, orgId),
        sql`lower(${githubCoveredRepositories.fullName}) = ${fullName.toLowerCase()}`,
        eq(githubInstallations.appId, appId),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubInstallations.installationId))
    .limit(1);
  return row;
}
