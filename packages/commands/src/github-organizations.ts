import { githubConnectedInstallations, githubInstallations } from "@tiehall/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { everyPage, gitHubFailedCall, statusOfCall, type GitHubClient } from "./github-client.ts";
import { gitHubAccountNamed } from "./github-users.ts";
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
// A lookup has four answers. GitHub reports the account a member, or it
// positively reports that the account is not one: GitHub answers the lookup
// with 404, to a token that may see the organization's members, as below.
// GitHub fails the lookup: it answers with a server error or a rate-limit
// refusal, or not within the client's timeout (github-client.ts), which a
// sign-in answers with 502 (sign-in-admission.ts; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (7)). Or GitHub gives no
// report, as when it refuses, with an answer of its own, the token of an
// installation it suspended or deleted, or answers a token that may not see
// the members, as below. Neither of the last two ever counts as the account
// leaving or joining.
//
// GitHub serves its member endpoints to a requester that may not see an
// organization's members as it serves anyone: the check answers 302, to the
// organization's public members, and the member list holds the public members
// only. An installation's token is such a requester when GitHub issued it
// without the Members permission, as after an owner removed that permission,
// and for any organization but the installation's own, as when another
// organization took the login of the installation's organization after a
// rename, before the next listing reads the new login. Neither answer says
// anything of the installation's organization. So a lookup counts only when
// the token GitHub issued carries the Members permission and the login still
// names the installation's organization, by its account's numeric id, and the
// check's redirect is never followed. A member list counts only when GitHub
// also answers the check of a member it lists with 204, as it answers only a
// requester that sees the members: the client keeps a token, with the
// permissions GitHub issued it with, for up to an hour, and nothing in a list
// says whether it holds the public members only.

/**
 * What GitHub reports of an account's membership of an organization:
 * `unavailable` when GitHub failed the lookup, and `unknown` when it gave no
 * report for another reason.
 */
export type OrganizationReport = "member" | "not_member" | "unknown" | "unavailable";

/**
 * What a lookup that failed with this error reports: GitHub failing it, as
 * gitHubFailedCall() reads the error, or no report, as for GitHub's refusal of
 * the token of an installation it suspended or deleted, or of a call made
 * with a token it issued before.
 */
function failedLookup(error: unknown): OrganizationReport {
  return gitHubFailedCall(error) ? "unavailable" : "unknown";
}

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

const MEMBER = z.object({ id: z.number().int().positive(), login: z.string().min(1) });

/** An installation token as the client holds it, with the permissions GitHub issued it with. */
const INSTALLATION_TOKEN = z.object({ permissions: z.record(z.string(), z.string()) });

/**
 * Whether GitHub shows this installation its organization's members: the
 * token GitHub issued it carries the Members permission, and the login
 * Tiehall asks by names the installation's organization now, by its account's
 * numeric id. It throws when GitHub does not issue the token or does not
 * answer.
 */
async function seesMembers(client: GitHubClient, installation: OrganizationInstallation): Promise<boolean> {
  const token = INSTALLATION_TOKEN.safeParse(await client.installation(installation.installationId).auth({ type: "installation" }));
  const members = token.success ? token.data.permissions["members"] : undefined;
  if (members !== "read" && members !== "write") return false;
  const organization = await gitHubAccountNamed(client, installation.installationId, installation.organizationLogin);
  return organization?.type === "Organization" && organization.id === installation.organizationId;
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
 * What GitHub's membership check answers of the account with this login:
 * 204 for a member and 404 for anyone else, to a requester that sees the
 * organization's members; its 302, to the public members, which it answers a
 * requester that sees them only, is not followed, and is no report.
 */
async function membershipCheck(client: GitHubClient, installation: OrganizationInstallation, login: string): Promise<OrganizationReport> {
  let status: number;
  try {
    ({ status } = await client
      .installation(installation.installationId)
      .request("GET /orgs/{org}/members/{username}", { org: installation.organizationLogin, username: login, request: { redirect: "manual" } }));
  } catch (error) {
    const answered = statusOfCall(error);
    if (answered === 404) return "not_member";
    // The check's redirect, to the public members, which it answers a requester that may not see the members.
    if (answered !== undefined && answered >= 300 && answered < 400) return "unknown";
    return failedLookup(error);
  }
  return status === 204 ? "member" : "unknown";
}

/**
 * What GitHub reports of whether the account with this login, as GitHub gave
 * it just now, is a member of the installation's organization, asked with that
 * installation's own token.
 */
export async function organizationMembership(client: GitHubClient, installation: OrganizationInstallation, login: string): Promise<OrganizationReport> {
  try {
    if (!(await seesMembers(client, installation))) return "unknown";
  } catch (error) {
    return failedLookup(error);
  }
  return membershipCheck(client, installation, login);
}

/**
 * The numeric ids of every member of the installation's organization, as
 * GitHub lists them to that installation, 100 at a time; it throws when
 * GitHub does not give the whole list, as when it would list the public
 * members only. The list itself cannot tell: so GitHub's check of the first
 * member it lists must report them a member, which GitHub answers only a
 * requester that sees the organization's members, whatever permissions the
 * token was issued with.
 */
export async function organizationMemberIds(client: GitHubClient, installation: OrganizationInstallation): Promise<Set<number>> {
  if (!(await seesMembers(client, installation))) throw new Error("GitHub does not show the installation its organization's whole member list.");
  const pages = await everyPage(client.installation(installation.installationId), "GET /orgs/{org}/members", {
    org: installation.organizationLogin,
    per_page: 100,
  });
  const members = pages.flatMap((page) => z.array(MEMBER).parse(page));
  const first = members[0];
  if (first === undefined || (await membershipCheck(client, installation, first.login)) !== "member") {
    throw new Error("GitHub listed the installation its organization's public members only.");
  }
  return new Set(members.map(({ id }) => id));
}
