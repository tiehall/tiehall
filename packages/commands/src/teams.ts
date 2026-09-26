import { addTeamMember, changeTeamKey, createTeam, removeTeamMember, renameTeam } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { teamKeyAliases, teamMembers, teams } from "@tiehall/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { memberOf } from "./members.ts";
import type { OrgContext } from "./with-org.ts";

// The team operations (teams-and-roles: Teams; teams-and-roles: What admins
// and members may do; teams-and-roles: Team keys). execute() runs them only
// for an admin, in the web UI: they are admin actions, which no agent surface
// offers and no job or GitHub event runs, so who belongs to a team is only
// ever what an admin set in Tiehall. A user can belong to several teams and a team may have no members.
// Team changes are not security events (design.md, Readings to confirm with
// the founder: R21) and change no request, so they write their change in the
// call's transaction without an event.
//
// Every key is unique in the install, counting the keys teams had before a
// rename: a team's old key stays its alias, so no other team can take it, and
// a key in use by another team gets 409 and changes nothing. The key's form is
// the catalog schema's, and the database checks it again.

/**
 * The advisory lock that serializes changes to team keys, so two changes can
 * never both find a key free: "tieh" in ASCII and 1, in the two-key space,
 * which no single-key lock shares.
 */
const TEAM_KEYS_LOCK = sql`SELECT pg_advisory_xact_lock(1953064296, 1)`;

/**
 * Refuses, with 409, a key that another team has now or had before a rename;
 * the team named, if any, may take its own. The caller holds the lock on team
 * keys, so the key stays free until its transaction ends.
 */
async function assertKeyFree({ tx, orgId }: OrgContext, key: string, teamId?: string): Promise<void> {
  const [current] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.key, key), ...(teamId === undefined ? [] : [ne(teams.id, teamId)])));
  const [alias] = await tx
    .select({ teamId: teamKeyAliases.teamId })
    .from(teamKeyAliases)
    .where(
      and(eq(teamKeyAliases.orgId, orgId), eq(teamKeyAliases.key, key), ...(teamId === undefined ? [] : [ne(teamKeyAliases.teamId, teamId)])),
    );
  if (current !== undefined || alias !== undefined) {
    throw new Refusal("conflict", "That key is taken: another team has it now, or had it before its key was changed.");
  }
}

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
  [createTeam.id]: defineHandler(createTeam, async ({ key, name }, context) => {
    await context.tx.execute(TEAM_KEYS_LOCK);
    await assertKeyFree(context, key);
    const [row] = await context.tx
      .insert(teams)
      .values({ orgId: context.orgId, key, name })
      .returning({ id: teams.id, key: teams.key, name: teams.name });
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
    const { tx, orgId } = context;
    await tx.execute(TEAM_KEYS_LOCK);
    const current = await teamOf(context, teamId);
    if (current.key === key) return current;
    await assertKeyFree(context, key, teamId);
    // The old key stays the team's alias; a key the team takes back is its alias no more.
    await tx.insert(teamKeyAliases).values({ orgId, key: current.key, teamId });
    await tx.delete(teamKeyAliases).where(and(eq(teamKeyAliases.orgId, orgId), eq(teamKeyAliases.key, key)));
    const [row] = await tx
      .update(teams)
      .set({ key })
      .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)))
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
