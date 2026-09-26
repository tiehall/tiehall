import { listMembers, setBotFlag } from "@tiehall/catalog";
import { Refusal, type Role } from "@tiehall/core";
import { members, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";

// The install's users as the web UI lists them, and the bot flag
// (teams-and-roles: Bot users; teams-and-roles: What admins and members may
// do). Every user is an identity of kind human. An admin sets and clears the
// bot flag on a member in the web UI; v1 counts no seats, so the flag's only
// effect is that it is shown wherever a user is listed or named. Setting it is
// not a security event (design.md, Readings to confirm with the founder: R21)
// and changes no request, so it writes its change without an event, and it
// changes nothing else about the user: their role, teams and tokens stay.

export const USER_HANDLERS: Handlers = {
  [setBotFlag.id]: defineHandler(setBotFlag, async ({ userId, bot }, { tx, orgId }) => {
    const [member] = await tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
    if (member === undefined) throw new Refusal("record-not-found", "That person is not a member of the install.");
    await tx
      .update(users)
      .set({ bot })
      .where(and(eq(users.orgId, orgId), eq(users.id, userId)));
    return { userId, bot };
  }),

  [listMembers.id]: defineHandler(listMembers, async (_input, { tx, orgId }) => {
    const rows = await tx
      .select({ id: users.id, login: users.githubLogin, bot: users.bot, role: members.role })
      .from(members)
      .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
      .where(eq(members.orgId, orgId))
      .orderBy(asc(users.githubLogin));
    const memberships = await tx
      .select({ userId: teamMembers.userId, key: teams.key })
      .from(teamMembers)
      .innerJoin(teams, and(eq(teams.orgId, teamMembers.orgId), eq(teams.id, teamMembers.teamId)))
      .where(eq(teamMembers.orgId, orgId))
      .orderBy(asc(teams.key));
    const teamsOf = new Map<string, string[]>();
    for (const { userId, key } of memberships) teamsOf.set(userId, [...(teamsOf.get(userId) ?? []), key]);
    return {
      members: rows.map(({ id, login, bot, role }) => ({ id, login, kind: "human" as const, bot, role: role as Role, teams: teamsOf.get(id) ?? [] })),
    };
  }),
};
