import type { CommandDefinition } from "@tiehall/catalog";
import { Refusal, roleAllows, type Role } from "@tiehall/core";
import { members, teamMembers, teams } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// The members of the install (teams-and-roles: Two roles, admin and member;
// teams-and-roles: The role bounds every caller acting for a user). A user is a
// member while the install holds their membership, which carries their one
// role. Every call made for a user reads it inside the call's own
// transaction, so a role change applies from the user's next call, through
// every session and token that acts for them.

/** A member of the install, as a call made for them sees them. */
export interface Member {
  userId: string;
  role: Role;
}

/** The user's membership, read in the call's transaction; undefined when they are not a member. */
export async function memberOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<Member | undefined> {
  const [row] = await tx
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  return row === undefined ? undefined : { userId, role: row.role as Role };
}

/**
 * Refuses an admin action with 403 to a user whose role does not allow it, as
 * the role matrix says (teams-and-roles: What admins and members may do).
 */
export function assertRoleAllows(definition: Pick<CommandDefinition, "admin">, member: Member | undefined): void {
  if (definition.admin === undefined) return;
  if (member === undefined || !roleAllows(member.role, definition.admin)) {
    throw new Refusal("forbidden", "Only an admin of the install may do this.");
  }
}

/** A team a member belongs to, by its id and current key. */
export interface MemberTeam {
  id: string;
  key: string;
}

/** The teams a member belongs to now, in the order of their keys, read in the call's transaction. */
export async function teamsOfMember({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<MemberTeam[]> {
  return tx
    .select({ id: teams.id, key: teams.key })
    .from(teamMembers)
    .innerJoin(teams, and(eq(teams.orgId, teamMembers.orgId), eq(teams.id, teamMembers.teamId)))
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId)))
    .orderBy(asc(teams.key));
}

/**
 * A user as a page or a server text names them: by their GitHub login, marked
 * when an admin flagged them as a bot, so a bot is marked wherever the web UI
 * names one (teams-and-roles: Bot users).
 */
export function userName(user: { login: string; bot: boolean }): string {
  return user.bot ? `${user.login} (a bot user)` : user.login;
}
