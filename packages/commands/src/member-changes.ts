import { changeMemberRole, removeMember } from "@tiehall/catalog";
import { leavesNoAdmin, memberRemoved, memberRoleChanged, Refusal, type Role } from "@tiehall/core";
import { members, signInBlocks, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { OrgContext } from "./with-org.ts";

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
// naming them. An admin removal also blocks their GitHub account from
// rejoining through organization membership. Ending the person's stored web
// sessions joins the removal once the sign-in service stores sessions (task
// 7.6), and revoking their agent grants and personal access tokens once those
// exist (task 15.19); until then, and after, the membership re-check refuses
// every call through them.

/** A member as a review or a change sees them: their GitHub account, its login and their role. */
async function memberRecord(
  { tx, orgId }: OrgContext,
  userId: string,
  lock: boolean,
): Promise<{ login: string; githubAccountId: number; role: Role }> {
  const query = tx
    .select({ login: users.githubLogin, githubAccountId: users.githubAccountId, role: members.role })
    .from(members)
    .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  const [row] = lock ? await query.for("update", { of: members }) : await query;
  if (row === undefined) throw new Refusal("record-not-found", "That person is not a member of the install.");
  return { login: row.login, githubAccountId: row.githubAccountId, role: row.role as Role };
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

/** The install's admins, with their rows locked until the call's transaction ends. */
async function lockAdmins({ tx, orgId }: OrgContext): Promise<string[]> {
  const rows = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.role, "admin")))
    .for("update");
  return rows.map(({ userId }) => userId);
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
      // Their memberships of teams go with it: the foreign key cascades.
      await writer.tx.delete(members).where(and(eq(members.orgId, writer.orgId), eq(members.userId, userId)));
      await writer.tx.insert(signInBlocks).values({ orgId: writer.orgId, githubAccountId: member.githubAccountId }).onConflictDoNothing();
      await writer.record(memberRemoved, { userId, cause: "admin", blocked: true });
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
        ? [{ text: `${member.login} already has the role ${role}, so confirming changes nothing.` }]
        : [
            { text: `Change the role of ${member.login}, the member with that GitHub login, from ${member.role} to ${role}.` },
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
            ? `Remove yourself, ${member.login}, from the install. You lose access at once.`
            : `Remove ${member.login}, the member with that GitHub login and the role ${member.role}, from the install.`,
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
