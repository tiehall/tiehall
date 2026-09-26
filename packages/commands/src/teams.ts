import { addTeamMember, changeTeamKey, createTeam, removeTeamMember, renameTeam } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { teamMembers, teams } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { memberOf } from "./members.ts";
import type { OrgContext } from "./with-org.ts";

// The team operations (teams-and-roles: Teams; teams-and-roles: What admins
// and members may do). execute() runs them only for an admin, in the web UI:
// they are admin actions, which no agent surface offers and no job or GitHub
// event runs, so who belongs to a team is only ever what an admin set in
// Tiehall. A user can belong to several teams and a team may have no members.
// Team changes are not security events (design.md, Readings to confirm with
// the founder: R21) and change no request, so they write their change in the
// call's transaction without an event.

/** The team, read in the call's transaction; 404 when the install has no such team. */
async function teamOf({ tx, orgId }: OrgContext, teamId: string): Promise<{ id: string; key: string; name: string }> {
  const [row] = await tx
    .select({ id: teams.id, key: teams.key, name: teams.name })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
  if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
  return row;
}

export const TEAM_HANDLERS: Handlers = {
  [createTeam.id]: defineHandler(createTeam, async ({ key, name }, { tx, orgId }) => {
    const [row] = await tx.insert(teams).values({ orgId, key, name }).returning({ id: teams.id, key: teams.key, name: teams.name });
    if (row === undefined) throw new Error("The new team was not returned.");
    return row;
  }),

  [renameTeam.id]: defineHandler(renameTeam, async ({ teamId, name }, context) => {
    await teamOf(context, teamId);
    const [row] = await context.tx
      .update(teams)
      .set({ name })
      .where(and(eq(teams.orgId, context.orgId), eq(teams.id, teamId)))
      .returning({ id: teams.id, key: teams.key, name: teams.name });
    if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
    return row;
  }),

  [changeTeamKey.id]: defineHandler(changeTeamKey, async ({ teamId, key }, context) => {
    await teamOf(context, teamId);
    const [row] = await context.tx
      .update(teams)
      .set({ key })
      .where(and(eq(teams.orgId, context.orgId), eq(teams.id, teamId)))
      .returning({ id: teams.id, key: teams.key, name: teams.name });
    if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
    return row;
  }),

  [addTeamMember.id]: defineHandler(addTeamMember, async ({ teamId, userId }, context) => {
    await teamOf(context, teamId);
    if ((await memberOf(context, userId)) === undefined) throw new Refusal("record-not-found", "That person is not a member of the install.");
    // Adding someone who is already in the team changes nothing.
    await context.tx.insert(teamMembers).values({ orgId: context.orgId, teamId, userId }).onConflictDoNothing();
    return { teamId, userId };
  }),

  [removeTeamMember.id]: defineHandler(removeTeamMember, async ({ teamId, userId }, context) => {
    await teamOf(context, teamId);
    await context.tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.orgId, context.orgId), eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return { teamId, userId };
  }),
};
