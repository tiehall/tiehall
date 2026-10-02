import { Refusal } from "@tiehall/core";
import { githubConnectedInstallations, githubCoveredRepositories, githubInstallations } from "@tiehall/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { gitHubUnavailable, GitHubUnavailableError, statusOfCall, type GitHubClient } from "./github-client.ts";
import { memberOfGitHubAccount } from "./github-users.ts";
import type { OrgContext } from "./with-org.ts";

// Who requests a contract change (contract-changes: The provider PR's author
// is the requester; requester-loop: When the requester is a team; design.md,
// Decisions this change rests on: D14, D37; D28 #75; design.md, Self-hosting
// decisions: S4, S5). The install's GitHub App maps a provider pull request's
// author to a user: before contract.report takes a report, Tiehall reads the
// pull request from GitHub, outside any transaction, through the connected
// installation that covers the repository the run reports from, with that
// installation's token, and keeps the author's GitHub account id with the
// report. The requester of the requests the report's change set opens is the
// Tiehall user whose GitHub account that is, while the user is a member of the
// install, with the API's provider team as the requesting team; otherwise,
// when the account belongs to no Tiehall user, to one who is not a member, or
// cannot be known because no connected installation covers the repository or
// GitHub knows no such pull request, the provider team alone is the requester.
// The report's answer says which, for the contract Action to comment on the
// pull request when the provider team is. GitHub failing the read is refused
// with 502, as the error model gives an integration that fails, and takes no
// report; the Action fails open, and its next run reports again.

/** A pull request's author as GitHub names them: the GitHub account's id and its login now. */
export interface PullRequestAuthor {
  id: number;
  login: string;
}

const PULL_REQUEST = z.object({ number: z.number().int().positive(), user: z.object({ id: z.number().int().positive(), login: z.string().min(1) }).nullable() });

/** The connected installation of the App, neither suspended nor deleted, that covers the repository, by GitHub's ids; undefined when none does. */
export async function installationCovering({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, appId: number, repositoryId: number): Promise<{ installationId: number; fullName: string } | undefined> {
  const [row] = await tx
    .select({ installationId: githubInstallations.installationId, fullName: githubCoveredRepositories.fullName })
    .from(githubCoveredRepositories)
    .innerJoin(githubInstallations, and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)))
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubCoveredRepositories.orgId), eq(githubConnectedInstallations.installationId, githubCoveredRepositories.installationId)),
    )
    .where(
      and(
        eq(githubCoveredRepositories.orgId, orgId),
        eq(githubCoveredRepositories.repositoryId, repositoryId),
        eq(githubInstallations.appId, appId),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubInstallations.installationId))
    .limit(1);
  return row;
}

/**
 * The author of a repository's pull request, as GitHub's API gives it now to
 * the installation that covers it; undefined when GitHub knows no such pull
 * request, or names no author, as for a deleted account. It throws
 * GitHubUnavailableError when GitHub fails the read or does not answer it.
 */
export async function pullRequestAuthor(client: GitHubClient, installationId: number, fullName: string, number: number): Promise<PullRequestAuthor | undefined> {
  const [owner = "", repo = ""] = fullName.split("/");
  let data: unknown;
  try {
    ({ data } = await client.installation(installationId).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number }));
  } catch (error) {
    if (statusOfCall(error) === 404) return undefined;
    throw gitHubUnavailable("the read of the provider pull request", error);
  }
  const pullRequest = PULL_REQUEST.safeParse(data);
  // An answer that names no pull request, or another one, is GitHub failing the read.
  if (!pullRequest.success || pullRequest.data.number !== number) throw new GitHubUnavailableError("GitHub's answer to the read of the provider pull request names no such pull request.");
  return pullRequest.data.user === null ? undefined : { id: pullRequest.data.user.id, login: pullRequest.data.user.login };
}

/** GitHub failing the read of the provider pull request, as the error model's refusal: no report is taken. */
export function authorUnavailable(error: GitHubUnavailableError): Refusal {
  return new Refusal("integration-unavailable", `${error.message} Tiehall took no report, so that the requester of its requests is known; the next run of the contract Action reports again.`);
}

/** The requesting user of a contract-change request from the author's GitHub account: its Tiehall user while a member of the install, or none. */
export async function requestingUserOf(context: Pick<OrgContext, "tx" | "orgId">, authorGitHubId: number | null): Promise<string | null> {
  if (authorGitHubId === null) return null;
  return (await memberOfGitHubAccount(context, { id: authorGitHubId })) ?? null;
}
