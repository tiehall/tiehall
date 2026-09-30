import { changeMemberRole, removeMember } from "@tiehall/catalog";
import { leavesNoAdmin, memberRemoved, memberRoleChanged, Refusal, type Provenance, type Role } from "@tiehall/core";
import { memberOrganizations, members, signInBlocks, teamMembers, teams, users, webSessions } from "@tiehall/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { revokeAgentAccessOf } from "./agent-grants.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { JobSender } from "./jobs.ts";
import { userName } from "./members.ts";
import { revokePersonalAccessTokensOf } from "./personal-access-tokens.ts";
import { cancelProposalsOfRemovedMember, lockProposalsOfMember } from "./proposals.ts";
import type { OrgContext } from "./with-org.ts";
import { writeIn, type Origin, type Writer } from "./write.ts";

// Changes to who is a member of the install and in which role
// (teams-and-roles: Changing a member's role; teams-and-roles: Removing a
// member; teams-and-roles: Two roles, admin and member; sign-in: An admin
// removal blocks rejoining through the organization; activity-log: Which
// actions are security events). An admin makes them in the web UI, each with
// the confirmation step for that exact change. A change takes effect from the
// member's next call, because every call made for a user reads their
// membership afresh: after a removal, every call through any session or token
// of theirs gets 403 removed-member and no data. The install always keeps at
// least one admin: the admins' rows are locked first, so two changes made at
// once cannot both leave the other admin in place and remove the last, and a
// change that would leave none gets 409 and changes nothing. Each change and
// its security event commit together or not at all.
//
// A removal deletes the membership, and with it every membership of a team;
// the user stays, so the requests, messages and events they took part in keep
// naming them, and their claims stay. Every pending proposal whose accountable
// human they are is cancelled, each with its event (requests: A removed
// member's claims stay and their proposals are cancelled); their requests and
// they are locked before the removal's first event, after the members' rows,
// in the lock order (event-sequence.ts). An admin removal also blocks their GitHub account from
// rejoining through organization membership. The removal ends every web
// session the person holds, in its transaction (sign-in: Signing out and
// ending sessions): a request that still carries one is refused with 403 and
// no data, and none works again, even after the person rejoins. It also
// revokes, in its transaction, every agent grant they gave, the tiehall CLI's
// included, and every personal access token they hold, each with its security
// event, with the refresh tokens, the approved device codes and the unused
// authorization codes of theirs (agent-grants.ts; personal-access-tokens.ts):
// while they are not a member, a call with any of them gets 403 as for a
// removed member, and once they are admitted again, 401 as a revoked token;
// an access token issued before the removal, which lives 10 minutes, is
// refused as revoked too, since it was issued before their current membership
// began (with-org.ts).
//
// A member who joined through membership of a GitHub organization is also
// removed when they leave it (sign-in: Leaving the GitHub organization ends
// access; organization-departures.ts): the same removal, with no block, and
// never while they are the install's only admin.

/**
 * A member as a review or a change sees them: their GitHub account, the name a
 * review shows them by, which is their login, marked when they are a bot
 * (teams-and-roles: Bot users), and their role.
 */
async function memberRecord(
  { tx, orgId }: OrgContext,
  userId: string,
  lock: boolean,
): Promise<{ name: string; githubAccountId: number; role: Role }> {
  const query = tx
    .select({ login: users.githubLogin, bot: users.bot, githubAccountId: users.githubAccountId, role: members.role })
    .from(members)
    .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  const [row] = lock ? await query.for("update", { of: members }) : await query;
  if (row === undefined) throw new Refusal("record-not-found", "That person is not a member of the install.");
  return { name: userName(row), githubAccountId: row.githubAccountId, role: row.role as Role };
}

/** The keys of the teams a member belongs to, in order. */
async function teamKeysOf({ tx, orgId }: OrgContext, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: teams.key })
    .from(teamMembers)
    .innerJoin(teams, and(eq(teams.orgId, teamMembers.orgId), eq(teams.id, teamMembers.teamId)))
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId)))
    .orderBy(asc(teams.key));
  return rows.map(({ key }) => key);
}

/** The install's admins, with their rows locked, in the order of their ids, until the call's transaction ends. */
async function lockAdmins({ tx, orgId }: OrgContext): Promise<string[]> {
  const rows = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.role, "admin")))
    .orderBy(asc(members.userId))
    .for("update");
  return rows.map(({ userId }) => userId);
}

/**
 * Ends every web session a removed member holds, in the removal's
 * transaction: each stays, marked ended, so the sign-in service refuses a
 * request that still carries it with 403, now and after the person rejoins.
 */
export async function endWebSessionsOf({ tx, orgId }: OrgContext, userId: string): Promise<void> {
  await tx
    .update(webSessions)
    .set({ endedAt: sql`now()` })
    .where(and(eq(webSessions.orgId, orgId), eq(webSessions.userId, userId), isNull(webSessions.endedAt)));
}

/** Why a member is removed: an admin removed them, or GitHub reported them gone from an organization, through this installation. */
export type RemovalCause = { cause: "admin" } | { cause: "left_organization"; installationId: string };

/**
 * Removes a member, in the caller's write, which has locked the admins' rows
 * and the member's already: their membership goes, and with it their teams
 * and the organizations Tiehall saw them in; an admin removal blocks their
 * GitHub account; their web sessions end; the removal is recorded; and every
 * pending proposal they are the accountable human of is cancelled.
 */
export async function removeMembership(writer: Writer, member: { userId: string; githubAccountId: number }, removal: RemovalCause): Promise<void> {
  const { userId } = member;
  const requestIds = await lockProposalsOfMember(writer, userId);
  // Their memberships of teams, and the organizations they were seen in, go with it: the foreign keys cascade, under
  // the lock the caller holds on the member's row, which every writer of those records takes first (event-sequence.ts).
  await writer.tx.delete(members).where(and(eq(members.orgId, writer.orgId), eq(members.userId, userId)));
  if (removal.cause === "admin") {
    await writer.tx.insert(signInBlocks).values({ orgId: writer.orgId, githubAccountId: member.githubAccountId }).onConflictDoNothing();
  }
  await endWebSessionsOf(writer, userId);
  // Every grant and personal access token they hold is revoked, so none of them works again.
  await revokeAgentAccessOf(writer, userId, writer.now());
  await revokePersonalAccessTokensOf(writer, userId, writer.now());
  await writer.record(
    memberRemoved,
    removal.cause === "admin"
      ? { userId, cause: "admin", blocked: true }
      : { userId, cause: "left_organization", blocked: false, installationId: removal.installationId },
  );
  await cancelProposalsOfRemovedMember(writer, userId, requestIds);
}

/**
 * Removes a member because GitHub reported them gone from an organization
 * Tiehall saw them in, in its own write with the provenance of what found it:
 * only a member who joined through organization membership, and never the
 * install's only admin. Returns whether it removed them.
 */
export async function removeDepartedMember(
  context: OrgContext,
  jobs: JobSender,
  provenance: Provenance,
  input: { userId: string; installationId: string; origin?: Origin },
): Promise<boolean> {
  const admins = await lockAdmins(context);
  const [member] = await context.tx
    .select({ githubAccountId: users.githubAccountId })
    .from(members)
    .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
    .where(and(eq(members.orgId, context.orgId), eq(members.userId, input.userId)))
    .for("update", { of: members });
  if (member === undefined) return false;
  const [seen] = await context.tx
    .select({ githubOrganizationId: memberOrganizations.githubOrganizationId })
    .from(memberOrganizations)
    .where(and(eq(memberOrganizations.orgId, context.orgId), eq(memberOrganizations.userId, input.userId)))
    .limit(1);
  // A member who joined through an invite or by completing setup was seen in no organization, and stays.
  if (seen === undefined) return false;
  // The install keeps an admin: its only admin stays until another admin exists.
  if (leavesNoAdmin(admins, { kind: "removal", userId: input.userId })) return false;
  await writeIn(
    context,
    jobs,
    provenance,
    (writer) => removeMembership(writer, { userId: input.userId, githubAccountId: member.githubAccountId }, { cause: "left_organization", installationId: input.installationId }),
    input.origin === undefined ? {} : { origin: input.origin },
  );
  return true;
}

/** Refuses, with 409, a change that would leave the install without an admin. */
function keepAnAdmin(): Refusal {
  return new Refusal("conflict", "The install must keep at least one admin, so this change is refused.");
}

export const MEMBER_HANDLERS: Handlers = {
  [changeMemberRole.id]: defineHandler(changeMemberRole, async ({ userId, role }, context) => {
    const admins = await lockAdmins(context);
    const member = await memberRecord(context, userId, true);
    if (member.role === role) return { userId, role };
    if (leavesNoAdmin(admins, { kind: "role", userId, role })) throw keepAnAdmin();
    return context.write(async (writer) => {
      await writer.tx
        .update(members)
        .set({ role })
        .where(and(eq(members.orgId, writer.orgId), eq(members.userId, userId)));
      await writer.record(memberRoleChanged, { userId, role, previousRole: member.role });
      return { userId, role };
    });
  }),

  [removeMember.id]: defineHandler(removeMember, async ({ userId }, context) => {
    const admins = await lockAdmins(context);
    const member = await memberRecord(context, userId, true);
    if (leavesNoAdmin(admins, { kind: "removal", userId })) throw keepAnAdmin();
    return context.write(async (writer) => {
      await removeMembership(writer, { userId, githubAccountId: member.githubAccountId }, { cause: "admin" });
      return { userId };
    });
  }),
};

/** The review pages of the changes to members, in Tiehall's own words. */
export const MEMBER_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [changeMemberRole.id]: async (input, context) => {
    const { userId, role } = input as { userId: string; role: Role };
    const member = await memberRecord(context, userId, false);
    const lines =
      member.role === role
        ? [{ text: `${member.name} already has the role ${role}, so confirming changes nothing.` }]
        : [
            { text: `Change the role of the member ${member.name} from ${member.role} to ${role}.` },
            {
              text:
                role === "admin"
                  ? "As an admin, they can invite and remove members, change roles, manage teams, integrations and settings, and read the activity log."
                  : "As a member, they can no longer take any admin action.",
            },
            { text: "The new role applies from their next call, through every web session and token that acts for them." },
          ];
    return { title: "Change a member's role", lines };
  },

  [removeMember.id]: async (input, context) => {
    const { userId } = input as { userId: string };
    const member = await memberRecord(context, userId, false);
    const teamKeys = await teamKeysOf(context, userId);
    const yourself = userId === context.caller.userId;
    return {
      title: "Remove a member",
      lines: [
        {
          text: yourself
            ? `Remove yourself, ${member.name}, from the install. You lose access at once.`
            : `Remove the member ${member.name}, whose role is ${member.role}, from the install.`,
        },
        {
          text:
            teamKeys.length === 0
              ? "They belong to no team."
              : `They will no longer belong to the teams they are in: ${teamKeys.join(", ")}.`,
        },
        { text: "From their next call, every web session, agent grant and personal access token of theirs is refused." },
        {
          text: "Their GitHub account is blocked from rejoining through membership of a GitHub organization; only an invite an admin creates after this removal admits them again, in no team.",
        },
        { text: "The requests, messages and events they took part in stay, and keep naming them." },
      ],
    };
  },
};
