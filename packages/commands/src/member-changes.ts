import { changeMemberRole } from "@tiehall/catalog";
import { leavesNoAdmin, memberRoleChanged, Refusal, type Role } from "@tiehall/core";
import { members, users } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { OrgContext } from "./with-org.ts";

// Changes to who is a member of the install and in which role
// (teams-and-roles: Changing a member's role; teams-and-roles: Two roles,
// admin and member; activity-log: Which actions are security events). An
// admin makes them in the web UI, each with the confirmation step for that
// exact change. A change takes effect from the member's next call, because
// every call made for a user reads their membership afresh. The install always
// keeps at least one admin: the admins' rows are locked first, so two changes
// made at once cannot both leave the other admin in place and remove the
// last, and a change that would leave none gets 409 and changes nothing. Each
// change and its security event commit together or not at all.

/** A member as a review or a change sees them: their GitHub login and their role. */
async function memberRecord({ tx, orgId }: OrgContext, userId: string, lock: boolean): Promise<{ login: string; role: Role }> {
  const query = tx
    .select({ login: users.githubLogin, role: members.role })
    .from(members)
    .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  const [row] = lock ? await query.for("update", { of: members }) : await query;
  if (row === undefined) throw new Refusal("record-not-found", "That person is not a member of the install.");
  return { login: row.login, role: row.role as Role };
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
};
