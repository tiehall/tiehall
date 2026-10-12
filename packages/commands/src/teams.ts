import { addTeamMember, changeTeamKey, createTeam, listTeams, removeTeamMember, renameTeam, setTeamIntake, type IntakeField } from "@tiehall/catalog";
import { Refusal, teamMemberAdded, teamMemberRemoved } from "@tiehall/core";
import { teamKeyAliases, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { memberOf, teamsOfMember } from "./members.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// The team operations (teams-and-roles: Teams; teams-and-roles: What admins
// and members may do; teams-and-roles: Team keys). execute() runs them only
// for an admin, in the web UI: they are admin actions, which no agent surface
// offers and no job or GitHub event runs, so who belongs to a team is only
// ever what an admin set in Tiehall. A user can belong to several teams and a team may have no members.
// Adding a person to a team and removing one are security events, which name
// the admin, the person and the team, written in the call's transaction with
// the change, and need no confirmation step (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (82)); adding a person who is
// in the team already, or removing one who is not, changes nothing and records
// nothing. The other team changes, creating and renaming teams, their keys
// and their intake settings, are not security events (design.md, Readings to
// confirm with the founder: R21) and change no request, so they write their
// change in the call's transaction without an event.
//
// Every key is unique in the install, counting the keys teams had before a
// rename: a team's old key stays its alias, so no other team can take it, and
// a key in use by another team gets 409 and changes nothing. The key's form is
// the catalog schema's, and the database checks it again.
//
// The teams page of the web UI reads every team, in the order of their keys,
// with the keys each had before a rename, the people in each, named by their
// GitHub login with their bot mark (teams-and-roles: Bot users), and its
// intake settings; that read is an admin action too.
//
// A team's intake settings (agent-surfaces: Admins set a team's intake notes
// and required fields): an admin sets its intake notes and the packet fields
// it requires, which replace what it had; like every team change, they record
// no event (design.md, Readings to confirm with the founder: R21).

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
  [listTeams.id]: defineHandler(listTeams, async (_input, { tx, orgId }) => {
    const rows = await tx
      .select({ id: teams.id, key: teams.key, name: teams.name, intakeNotes: teams.intakeNotes, requiredFields: teams.requiredFields })
      .from(teams)
      .where(eq(teams.orgId, orgId))
      .orderBy(asc(teams.key));
    const aliases = await tx
      .select({ teamId: teamKeyAliases.teamId, key: teamKeyAliases.key })
      .from(teamKeyAliases)
      .where(eq(teamKeyAliases.orgId, orgId))
      .orderBy(asc(teamKeyAliases.key));
    const people = await tx
      .select({ teamId: teamMembers.teamId, id: users.id, login: users.githubLogin, bot: users.bot })
      .from(teamMembers)
      .innerJoin(users, and(eq(users.orgId, teamMembers.orgId), eq(users.id, teamMembers.userId)))
      .where(eq(teamMembers.orgId, orgId))
      .orderBy(asc(users.githubLogin));
    return {
      teams: rows.map(({ intakeNotes, requiredFields, ...team }) => ({
        ...team,
        intake: { requiredFields: requiredFields as IntakeField[], untrusted: { notes: intakeNotes } },
        aliases: aliases.filter(({ teamId }) => teamId === team.id).map(({ key }) => key),
        members: people.filter(({ teamId }) => teamId === team.id).map(({ id, login, bot }) => ({ id, login, kind: "human" as const, bot })),
      })),
    };
  }),

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

  [setTeamIntake.id]: defineHandler(setTeamIntake, async ({ teamId, notes, requiredFields }, context) => {
    await teamOf(context, teamId);
    // The teams the admin belongs to now, which decide the origin agents read the notes with, once these notes are theirs.
    const writerTeams = `{${(await teamsOfMember(context, actingUserOf(context))).map(({ id }) => id).join(",")}}`;
    const [row] = await context.tx
      .update(teams)
      .set({
        intakeNotes: notes,
        requiredFields,
        // A change of the required fields alone leaves the notes their writer's.
        intakeNotesWriterTeamIds: sql`CASE WHEN ${teams.intakeNotes} IS DISTINCT FROM ${notes} THEN ${writerTeams}::uuid[] ELSE ${teams.intakeNotesWriterTeamIds} END`,
      })
      .where(and(eq(teams.orgId, context.orgId), eq(teams.id, teamId)))
      .returning({ id: teams.id, key: teams.key, name: teams.name, intakeNotes: teams.intakeNotes, requiredFields: teams.requiredFields });
    if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const { intakeNotes, requiredFields: fields, ...team } = row;
    return { ...team, intake: { requiredFields: fields as IntakeField[], untrusted: { notes: intakeNotes } } };
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
    // Adding someone who is already in the team changes nothing, and records nothing.
    const added = await context.tx
      .insert(teamMembers)
      .values({ orgId: context.orgId, teamId, userId })
      .onConflictDoNothing()
      .returning({ userId: teamMembers.userId });
    if (added.length > 0) await context.write((writer) => writer.record(teamMemberAdded, { teamId, userId }));
    return { teamId, userId };
  }),

  [removeTeamMember.id]: defineHandler(removeTeamMember, async ({ teamId, userId }, context) => {
    await teamOf(context, teamId);
    const removed = await context.tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.orgId, context.orgId), eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .returning({ userId: teamMembers.userId });
    // Removing someone who is not in the team changes nothing, and records nothing.
    if (removed.length > 0) await context.write((writer) => writer.record(teamMemberRemoved, { teamId, userId }));
    return { teamId, userId };
  }),
};
