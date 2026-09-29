import { githubConnectedInstallations, githubInstallations } from "@tiehall/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { everyPage, type GitHubClient } from "./github-client.ts";
import type { OrgContext } from "./with-org.ts";

// Membership of the GitHub organizations whose installations an admin
// connected (sign-in: Who may sign in; sign-in: Leaving the GitHub
// organization ends access; design.md, Self-hosting decisions: S5). Tiehall
// asks GitHub with the organization's own installation token, through the
// App's Members permission, and only through an installation that is working:
// connected, of the App in use, and neither suspended nor deleted as the last
// listing found it. GitHub also refuses a token for an installation it
// suspended since, so such a lookup fails.
//
// A lookup has three answers. GitHub reports the account a member, or it
// positively reports that the account is not one: GitHub answers the lookup
// with 404, and also shows the installation its organization's member list,
// so the 404 is not an organization that is gone or out of the installation's
// reach. Anything else, a server error, a refused token or no answer at all,
// is no report, and never counts as the account leaving or joining; so is a
// lookup GitHub does not answer within the client's timeout (github-client.ts).

/** What GitHub reports of an account's membership of an organization. */
export type OrganizationReport = "member" | "not_member" | "unknown";

/** A connected installation of the App on a GitHub organization, which may be asked who its members are. */
export interface OrganizationInstallation {
  /** Tiehall's id of the installation, which events name. */
  id: string;
  /** GitHub's numeric id of the installation. */
  installationId: number;
  /** The organization, by its account's numeric id and its login when last listed. */
  organizationId: number;
  organizationLogin: string;
}

const MEMBER = z.object({ id: z.number().int().positive() });

/** The HTTP status of a failed call to GitHub, or undefined when GitHub gave none. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The working connected installations of the App on GitHub organizations,
 * read in the caller's transaction, in the order of GitHub's ids: connected,
 * of the App with this id, and neither suspended nor deleted.
 */
export async function workingOrganizationInstallations(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  appId: number,
): Promise<OrganizationInstallation[]> {
  const rows = await tx
    .select({
      id: githubInstallations.id,
      installationId: githubInstallations.installationId,
      organizationId: githubInstallations.accountId,
      organizationLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
    )
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.appId, appId),
        eq(githubInstallations.accountType, "Organization"),
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubInstallations.installationId));
  return rows;
}

/**
 * What GitHub reports of whether the account with this login, as GitHub gave
 * it just now, is a member of the installation's organization, asked with that
 * installation's own token.
 */
export async function organizationMembership(client: GitHubClient, installation: OrganizationInstallation, login: string): Promise<OrganizationReport> {
  const octokit = client.installation(installation.installationId);
  try {
    const answer = await octokit.request("GET /orgs/{org}/members/{username}", { org: installation.organizationLogin, username: login });
    // GitHub answers 204 for a member; Octokit's types know only the redirect it answers to a caller outside the organization.
    return (answer.status as number) === 204 ? "member" : "unknown";
  } catch (error) {
    if (statusOf(error) !== 404) return "unknown";
  }
  // A 404 is a report only while GitHub still shows the installation its organization's members.
  try {
    await octokit.request("GET /orgs/{org}/members", { org: installation.organizationLogin, per_page: 1 });
    return "not_member";
  } catch {
    return "unknown";
  }
}

/**
 * The numeric ids of every member of the installation's organization, as
 * GitHub lists them to that installation, 100 at a time; it throws when
 * GitHub does not give the whole list.
 */
export async function organizationMemberIds(client: GitHubClient, installation: OrganizationInstallation): Promise<Set<number>> {
  const pages = await everyPage(client.installation(installation.installationId), "GET /orgs/{org}/members", {
    org: installation.organizationLogin,
    per_page: 100,
  });
  const ids = new Set<number>();
  for (const page of pages) {
    for (const member of z.array(MEMBER).parse(page)) ids.add(member.id);
  }
  return ids;
}
