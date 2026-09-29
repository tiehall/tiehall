import type { Provenance } from "@tiehall/core";
import { memberOrganizations, members, users, type Database } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import type { GitHubEventProcessor } from "./github-delivery-processing.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import {
  organizationMemberIds,
  organizationMembership,
  workingOrganizationInstallations,
  type OrganizationInstallation,
  type OrganizationReport,
} from "./github-organizations.ts";
import { gitHubAccountWithId, userOfGitHubAccount } from "./github-users.ts";
import type { Logger } from "./log.ts";
import { removeDepartedMember } from "./member-changes.ts";
import { withOrg, type OrgContext } from "./with-org.ts";

// Leaving the GitHub organization ends access (sign-in: Leaving the GitHub
// organization ends access; activity-log: Which actions are security events;
// design.md, Self-hosting decisions: S5). A member who joined through
// membership of a GitHub organization is kept as seen in each organization
// that reported them a member (sign-in-admission.ts). They are removed, as an
// admin removal would remove them but with no block, once GitHub positively
// reports, through a working connected installation, that the account is no
// longer a member of an organization Tiehall has seen it in, and no working
// connected installation reports it a member of its organization. So:
// - an organization that reports them a member keeps them, and is kept as one
//   they were seen in;
// - a report that could not be had, a failed lookup or a whole member list
//   GitHub did not give, keeps them: no failure counts as leaving;
// - an installation that is suspended, deleted or disconnected is not asked
//   at all, so it never reports anyone gone;
// - a member seen in no organization, who joined through an invite or by
//   completing setup, is never removed this way, and neither is the install's
//   only admin, until another admin exists (member-changes.ts).
// Tiehall checks at every sign-in of such a member, asking about their login
// as GitHub gave it for that sign-in; on an `organization` event that reports
// a member removed from an organization with a connected installation; and in
// the reconciliation job every 15 minutes, in either GitHub mode, which reads
// each working organization's whole member list once and judges every such
// member by their account's numeric id (github-reconciliation.ts). Each
// removal is a security event that names the installation whose organization
// GitHub reported them gone from.
//
// The event is a hint, never the report itself (github-delivery-
// processing.ts): GitHub's signature covers only a delivery's body, not its
// delivery id or event name, so a captured body can come back under a new
// delivery id, and GitHub may deliver late or out of order. So the member the
// event names, by their account's numeric id, is checked as at a sign-in:
// GitHub is asked for the account's login now, since the one the event names
// may be old, and each working connected installation's organization is asked
// now whether that login is a member. A replayed or stale report of a member
// who has since rejoined, or renamed their login, removes nobody, and a report
// that cannot be checked, because GitHub does not answer, removes nobody
// either: the reconciliation checks again within 15 minutes. Deliveries are not deduplicated by their
// body: two genuine reports of one person leaving can be byte for byte the
// same, since the payload carries no time.

export interface DepartureServices {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's App, whose installations are asked. */
  app: GitHubAppAccess;
  logger: Logger;
  /** Who removes a departed member: the integration that reported it, or the system's job or sign-in check that found it. */
  provenance: Provenance;
}

/** Whom to check: one member, by their login as GitHub gave it just now; or every member seen in an organization. */
export type DepartureScope = { userId: string; login: string } | { every: true };

/** A member Tiehall has seen in organizations: their GitHub account and the organizations, by their accounts' numeric ids. */
interface SeenMember {
  userId: string;
  githubAccountId: number;
  seen: ReadonlySet<number>;
}

/** What GitHub's reports say of a member: gone, through the installation whose organization reported it, or staying, with the organizations that report them a member. */
export type Departure = { left: OrganizationInstallation } | { stays: readonly number[] };

/**
 * Judges a member Tiehall saw in these organizations by what each working
 * connected installation's organization reports of them, by the organization's
 * account id; an organization that gave no report counts as unknown.
 */
export function departureOf(seen: ReadonlySet<number>, installations: readonly OrganizationInstallation[], reports: ReadonlyMap<number, OrganizationReport>): Departure {
  const reportOf = (installation: OrganizationInstallation) => reports.get(installation.organizationId) ?? "unknown";
  const reporting = installations.filter((installation) => reportOf(installation) === "member").map(({ organizationId }) => organizationId);
  if (reporting.length > 0) return { stays: reporting };
  if (installations.some((installation) => reportOf(installation) === "unknown")) return { stays: [] };
  const left = installations.find((installation) => seen.has(installation.organizationId) && reportOf(installation) === "not_member");
  return left === undefined ? { stays: [] } : { left };
}

/** The members Tiehall has seen in organizations, or the one named, with the organizations it saw them in. */
async function seenMembers({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId?: string): Promise<SeenMember[]> {
  const rows = await tx
    .select({ userId: memberOrganizations.userId, githubAccountId: users.githubAccountId, organizationId: memberOrganizations.githubOrganizationId })
    .from(memberOrganizations)
    .innerJoin(members, and(eq(members.orgId, memberOrganizations.orgId), eq(members.userId, memberOrganizations.userId)))
    .innerJoin(users, and(eq(users.orgId, memberOrganizations.orgId), eq(users.id, memberOrganizations.userId)))
    .where(and(eq(memberOrganizations.orgId, orgId), ...(userId === undefined ? [] : [eq(memberOrganizations.userId, userId)])));
  const byUser = new Map<string, { githubAccountId: number; seen: Set<number> }>();
  for (const row of rows) {
    const member = byUser.get(row.userId) ?? { githubAccountId: row.githubAccountId, seen: new Set<number>() };
    member.seen.add(row.organizationId);
    byUser.set(row.userId, member);
  }
  return [...byUser].map(([id, member]) => ({ userId: id, ...member }));
}

/**
 * Keeps a member as seen in the organizations that report them a member now,
 * if they still joined through an organization. In the lock order
 * (event-sequence.ts), it locks the member's row before it writes the records
 * of their organizations, and writes nothing once the member is gone: a
 * removal that holds the row goes first, and the records go with the member.
 */
async function stillSeenIn({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string, organizations: readonly number[]): Promise<void> {
  if (organizations.length === 0) return;
  const [member] = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)))
    .for("key share");
  if (member === undefined) return;
  const [any] = await tx
    .select({ userId: memberOrganizations.userId })
    .from(memberOrganizations)
    .where(and(eq(memberOrganizations.orgId, orgId), eq(memberOrganizations.userId, userId)))
    .limit(1);
  if (any === undefined) return;
  await tx
    .insert(memberOrganizations)
    .values(organizations.map((githubOrganizationId) => ({ orgId, userId, githubOrganizationId })))
    .onConflictDoUpdate({ target: [memberOrganizations.orgId, memberOrganizations.userId, memberOrganizations.githubOrganizationId], set: { lastSeenAt: sql`now()` } });
}

/**
 * Checks whether members Tiehall saw in organizations left them, and removes
 * those GitHub positively reports gone; returns the users it removed. Every
 * call to GitHub is made outside any transaction, and each removal is its own
 * write, which reads the member's state again.
 */
export async function checkDepartures(services: DepartureServices, scope: DepartureScope): Promise<string[]> {
  const { database, app, logger } = services;
  const state = await withOrg(
    database,
    async (context) => ({
      installations: await workingOrganizationInstallations(context, app.appId),
      members: await seenMembers(context, "every" in scope ? undefined : scope.userId),
    }),
    { readOnly: true },
  );
  if (state.members.length === 0) return [];

  const reportsOf = new Map<string, Map<number, OrganizationReport>>();
  if ("every" in scope) {
    // One whole member list per organization, and every member judged by their account's numeric id.
    const lists = new Map<number, Set<number> | undefined>();
    for (const installation of state.installations) {
      try {
        lists.set(installation.organizationId, await organizationMemberIds(app.client, installation));
      } catch {
        logger.warn("github: GitHub did not list an organization's members", { installationId: installation.installationId });
        lists.set(installation.organizationId, undefined);
      }
    }
    for (const member of state.members) {
      const reports = new Map<number, OrganizationReport>();
      for (const [organizationId, list] of lists) reports.set(organizationId, list === undefined ? "unknown" : list.has(member.githubAccountId) ? "member" : "not_member");
      reportsOf.set(member.userId, reports);
    }
  } else {
    const reports = new Map<number, OrganizationReport>();
    for (const installation of state.installations) {
      reports.set(installation.organizationId, await organizationMembership(app.client, installation, scope.login));
    }
    for (const member of state.members) reportsOf.set(member.userId, reports);
  }

  const removed: string[] = [];
  const jobs = { send: () => Promise.reject(new Error("A departure sends no job.")) };
  for (const member of state.members) {
    const departure = departureOf(member.seen, state.installations, reportsOf.get(member.userId) ?? new Map());
    if ("stays" in departure) {
      await withOrg(database, (context) => stillSeenIn(context, member.userId, departure.stays));
      continue;
    }
    const gone = await withOrg(database, (context) =>
      removeDepartedMember(context, jobs, services.provenance, { userId: member.userId, installationId: departure.left.id }),
    );
    if (gone) {
      removed.push(member.userId);
      logger.info("github: a member who left a GitHub organization was removed", { userId: member.userId, installationId: departure.left.installationId });
    }
  }
  return removed;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function idOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The `organization` event's processor: a delivery from a connected
 * installation that reports a member removed from its organization is a hint,
 * and the member it names is checked at once against what GitHub reports now,
 * as the integration from GitHub.
 */
export const processOrganizationEvent: GitHubEventProcessor = async (event, context) => {
  if (event.action !== "member_removed") return;
  const accountId = idOf(objectOf(objectOf(event.payload["membership"])?.["user"])?.["id"]);
  if (accountId === undefined) return;
  const userId = await withOrg(context.database, (orgContext) => userOfGitHubAccount(orgContext, { id: accountId }));
  if (userId === undefined) return;
  // The account's login now, asked through the installation that delivered the event: the event's may be old.
  let account;
  try {
    account = await gitHubAccountWithId(context.app.client, event.installation.installationId, accountId);
  } catch (error) {
    context.logger.warn("github: GitHub did not name the account an organization event reports", { error, installationId: event.installation.installationId });
    return;
  }
  if (account?.type !== "User") return;
  await checkDepartures(
    { database: context.database, app: context.app, logger: context.logger, provenance: { actorKind: "integration", surface: "github" } },
    { userId, login: account.login },
  );
};
