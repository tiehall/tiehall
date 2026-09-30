import { getTeam, readDirectory, whoami, type IntakeField } from "@tiehall/catalog";
import { compareVersions, MINIMUM_SKILL_VERSION, Refusal } from "@tiehall/core";
import { teams, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf } from "./request-changes.ts";
import { teamOfKey } from "./request-keys.ts";

// whoami and directory (agent-surfaces: The MCP tools; teams-and-roles: Bot
// users; design.md, Decisions this change rests on: D28 #56, #94). whoami
// names the user the call acts for, with the bot flag an admin sets, the teams
// they belong to, by key, and the install by its URL, TIEHALL_URL, and warns
// when the version of the Tiehall skill the call names is older than
// MINIMUM_SKILL_VERSION (agent-surfaces: The Claude Code plugin). directory lists the install's teams by key,
// with their names, their intake notes and the fields they require (agent-surfaces: Admins set a team's intake
// notes and required fields), and the registered APIs with the teams declared as their
// consumers: none yet, since registering an API comes with the contract-change
// flow. teams.get reads one team as directory lists it, by its current key or
// an earlier one, for its intake page (agent-surfaces: Team intake pages); a
// key no team has or had gets 404. All three only read, and every member may
// run them.

export const DIRECTORY_HANDLERS: Handlers = {
  [whoami.id]: defineHandler(whoami, async ({ skillVersion }, context) => {
    const userId = actingUserOf(context);
    const [row] = await context.tx
      .select({ id: users.id, login: users.githubLogin, bot: users.bot })
      .from(users)
      .where(and(eq(users.orgId, context.orgId), eq(users.id, userId)));
    if (row === undefined) throw new Error("A member of the install has no user.");
    if (context.url === undefined) throw new Error("whoami names the install by its URL, which this process was not given.");
    const memberOf = await teamsOfMember(context, userId);
    // The skill names its version; one older than the install supports gets a warning.
    const warnings =
      skillVersion !== undefined && compareVersions(skillVersion, MINIMUM_SKILL_VERSION) < 0
        ? [{ kind: "skill_outdated" as const, skillVersion, minimum: MINIMUM_SKILL_VERSION }]
        : [];
    return { user: { id: row.id, login: row.login, kind: "human" as const, bot: row.bot }, teams: memberOf, install: { url: context.url }, warnings };
  }),

  [getTeam.id]: defineHandler(getTeam, async ({ key }, context) => {
    const found = await teamOfKey(context, key);
    if (found === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const [row] = await context.tx
      .select({ id: teams.id, key: teams.key, name: teams.name, intakeNotes: teams.intakeNotes, requiredFields: teams.requiredFields })
      .from(teams)
      .where(and(eq(teams.orgId, context.orgId), eq(teams.id, found.id)));
    if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
    return { id: row.id, key: row.key, requiredFields: row.requiredFields as IntakeField[], untrusted: { name: row.name, intakeNotes: row.intakeNotes } };
  }),

  [readDirectory.id]: defineHandler(readDirectory, async (_input, context) => {
    const rows = await context.tx
      .select({ id: teams.id, key: teams.key, name: teams.name, intakeNotes: teams.intakeNotes, requiredFields: teams.requiredFields })
      .from(teams)
      .where(eq(teams.orgId, context.orgId))
      .orderBy(asc(teams.key));
    return {
      teams: rows.map(({ id, key, name, intakeNotes, requiredFields }) => ({
        id,
        key,
        requiredFields: requiredFields as IntakeField[],
        untrusted: { name, intakeNotes },
      })),
      apis: [],
    };
  }),
};
