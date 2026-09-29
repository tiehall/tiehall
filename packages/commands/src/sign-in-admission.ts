import { memberJoined, type Role } from "@tiehall/core";
import { invites, memberOrganizations, members, signInBlocks, users, type Database } from "@tiehall/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { organizationMembership, workingOrganizationInstallations } from "./github-organizations.ts";
import type { InstallGitHub } from "./install-github.ts";
import { LOGGABLE, type Logger } from "./log.ts";
import { withOrg, type OrgContext } from "./with-org.ts";
import { writeIn, type Origin } from "./write.ts";

// Who may sign in (sign-in: Who may sign in; sign-in: New members join as
// members; activity-log: Which actions are security events; design.md,
// Self-hosting decisions: S5 and S6). A GitHub account may sign in when at
// least one of these holds:
// - its Tiehall user is already a member of the install;
// - it holds a valid invite: bound to the account's numeric id, neither
//   accepted nor revoked, and not expired;
// - GitHub reports, through a working installation of the App that an admin
//   connected, that the account is a member of that installation's
//   organization (github-organizations.ts), and no admin removal blocks it.
// An installation nobody connected admits no one, and a lookup that fails, or
// that would go through a suspended or deleted installation, admits no one
// through that organization. Anyone else is refused.
//
// The decision is made before the sign-in service writes anything, so a
// refused sign-in creates no session, no user and no membership, and every
// call to GitHub it needs is made outside any transaction. A person who is
// not a member yet joins once their user exists, just before their web
// session is stored, in one transaction with its security event: through a
// valid invite, which the sign-in accepts even when organization membership
// would also admit them, with the invite's role; or through organization
// membership, with the role `member`, in no team, whatever their role in the
// organization, and kept as seen in each organization that reported them a
// member, so that leaving it can end their access. The join is checked again
// in that transaction, so an invite revoked or accepted meanwhile admits no
// one.

/** How a sign-in admits a GitHub account. */
export type Admission =
  /** Its user is already a member of the install. */
  | { through: "member" }
  /** It holds a valid invite, which the sign-in accepts. */
  | { through: "invite"; inviteId: string; role: Role }
  /** GitHub reports it a member of these organizations, by their accounts' numeric ids, each through a working connected installation. */
  | { through: "organization"; organizations: readonly number[] };

export interface AdmissionServices {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's GitHub App, through whose installations membership is looked up. */
  github: InstallGitHub;
  logger: Logger;
}

/** A join that the check in its transaction no longer allows, such as one whose invite was revoked meanwhile. */
export class AdmissionWithdrawnError extends Error {
  override name = "AdmissionWithdrawnError";
  readonly [LOGGABLE] = true;
  constructor() {
    super("The sign-in's admission no longer holds, so the person does not join.");
  }
}

/** The newest valid invite bound to this GitHub account, if it holds one: neither accepted nor revoked, and not expired. */
async function validInvite({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, githubAccountId: number, lock = false) {
  const query = tx
    .select({ id: invites.id, role: invites.role })
    .from(invites)
    .where(
      and(
        eq(invites.orgId, orgId),
        eq(invites.githubAccountId, githubAccountId),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(invites.createdAt), desc(invites.id))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row === undefined ? undefined : { id: row.id, role: row.role as Role };
}

/** Whether an admin removal blocks this GitHub account from joining through organization membership. */
async function isBlocked({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, githubAccountId: number): Promise<boolean> {
  const [row] = await tx
    .select({ githubAccountId: signInBlocks.githubAccountId })
    .from(signInBlocks)
    .where(and(eq(signInBlocks.orgId, orgId), eq(signInBlocks.githubAccountId, githubAccountId)));
  return row !== undefined;
}

/**
 * Decides whether a GitHub account may sign in, by its numeric id and its
 * login as GitHub gave it for this sign-in; undefined refuses it. It reads
 * Tiehall's records in a read-only transaction, and asks GitHub outside it.
 */
export async function decideAdmission(services: AdmissionServices, account: { id: number; login: string }): Promise<Admission | undefined> {
  const app = await services.github.app();
  const state = await withOrg(
    services.database,
    async (context) => {
      const [member] = await context.tx
        .select({ userId: members.userId })
        .from(users)
        .innerJoin(members, and(eq(members.orgId, users.orgId), eq(members.userId, users.id)))
        .where(and(eq(users.orgId, context.orgId), eq(users.githubAccountId, account.id)));
      return {
        member: member !== undefined,
        invite: await validInvite(context, account.id),
        blocked: await isBlocked(context, account.id),
        organizations: app === undefined ? [] : await workingOrganizationInstallations(context, app.appId),
      };
    },
    { readOnly: true },
  );
  if (state.member) return { through: "member" };
  if (state.blocked) return undefined;
  if (state.invite !== undefined) return { through: "invite", inviteId: state.invite.id, role: state.invite.role };
  if (app === undefined || state.organizations.length === 0) return undefined;
  const reporting: number[] = [];
  for (const installation of state.organizations) {
    const report = await organizationMembership(app.client, installation, account.login);
    if (report === "member") reporting.push(installation.organizationId);
    else if (report === "unknown") services.logger.warn("sign-in service: GitHub gave no report of an organization membership", { installationId: installation.installationId });
  }
  return reporting.length === 0 ? undefined : { through: "organization", organizations: reporting };
}

/**
 * Makes a person whose sign-in was admitted a member of the install, once
 * their user exists and before their web session is stored, in one
 * transaction with the join's security event; a member already joins no second
 * time. It throws AdmissionWithdrawnError when the admission no longer holds.
 */
export async function applyAdmission(
  services: Pick<AdmissionServices, "database">,
  input: { userId: string; admission: Admission; origin: Origin },
): Promise<void> {
  const { userId, admission } = input;
  if (admission.through === "member") return;
  await withOrg(services.database, async (context) => {
    // One join per person at a time: their user's row is held until the transaction ends.
    const [user] = await context.tx
      .select({ githubAccountId: users.githubAccountId })
      .from(users)
      .where(and(eq(users.orgId, context.orgId), eq(users.id, userId)))
      .for("update");
    if (user === undefined) throw new AdmissionWithdrawnError();
    const [already] = await context.tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.orgId, context.orgId), eq(members.userId, userId)));
    if (already !== undefined) return;
    const jobs = { send: () => Promise.reject(new Error("A join sends no job.")) };
    await writeIn(
      context,
      jobs,
      { actorKind: "web_session", userId, surface: "web" },
      async (writer) => {
        if (admission.through === "invite") {
          const invite = await validInvite(writer, user.githubAccountId, true);
          if (invite?.id !== admission.inviteId) throw new AdmissionWithdrawnError();
          await writer.tx.insert(members).values({ orgId: writer.orgId, userId, role: invite.role });
          await writer.tx
            .update(invites)
            .set({ acceptedAt: sql`now()`, acceptedBy: userId })
            .where(and(eq(invites.orgId, writer.orgId), eq(invites.id, invite.id)));
          await writer.record(memberJoined, { userId, role: invite.role, through: "invite", inviteId: invite.id });
          return;
        }
        if (await isBlocked(writer, user.githubAccountId)) throw new AdmissionWithdrawnError();
        await writer.tx.insert(members).values({ orgId: writer.orgId, userId, role: "member" });
        await writer.tx
          .insert(memberOrganizations)
          .values(admission.organizations.map((githubOrganizationId) => ({ orgId: writer.orgId, userId, githubOrganizationId })))
          .onConflictDoNothing();
        await writer.record(memberJoined, { userId, role: "member", through: "organization" });
      },
      { origin: input.origin },
    );
  });
}
