import { readDirectory, whoami } from "@tiehall/catalog";
import { teams, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";

// whoami and directory (agent-surfaces: The MCP tools; teams-and-roles: Bot
// users; design.md, Decisions this change rests on: D28 #56, #94). whoami
// names the user the call acts for, with the bot flag an admin sets, and the
// install by its URL, TIEHALL_URL. directory lists the install's teams by key,
// with their names, and the registered APIs with the teams declared as their
// consumers: none yet, since registering an API comes with the contract-change
// flow. Both only read, and every member may run them.

export const DIRECTORY_HANDLERS: Handlers = {
  [whoami.id]: defineHandler(whoami, async (_input, context) => {
    const userId = actingUserOf(context);
    const [row] = await context.tx
      .select({ id: users.id, login: users.githubLogin, bot: users.bot })
      .from(users)
      .where(and(eq(users.orgId, context.orgId), eq(users.id, userId)));
    if (row === undefined) throw new Error("A member of the install has no user.");
    if (context.url === undefined) throw new Error("whoami names the install by its URL, which this process was not given.");
    return { user: { id: row.id, login: row.login, kind: "human" as const, bot: row.bot }, install: { url: context.url } };
  }),

  [readDirectory.id]: defineHandler(readDirectory, async (_input, context) => {
    const rows = await context.tx
      .select({ id: teams.id, key: teams.key, name: teams.name })
      .from(teams)
      .where(eq(teams.orgId, context.orgId))
      .orderBy(asc(teams.key));
    return { teams: rows.map(({ id, key, name }) => ({ id, key, untrusted: { name } })), apis: [] };
  }),
};
