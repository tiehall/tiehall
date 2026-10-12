import { DIRECTORY_PAGE_ITEMS, getTeam, PAGE_CHARACTERS, readDirectory, whoami, type IntakeField } from "@tiehall/catalog";
import { compareVersions, MINIMUM_SKILL_VERSION, Refusal } from "@tiehall/core";
import { apis, teams, users } from "@tiehall/db";
import { createAgentView } from "@tiehall/packet/render";
import { directoryText, type DirectoryJson, type Reader } from "@tiehall/packet/tool-text";
import { and, asc, eq, gt, isNull, type SQL } from "drizzle-orm";
import { consumersOf } from "./api-consumers.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf } from "./request-changes.ts";
import { teamOfKey } from "./request-keys.ts";
import type { OrgContext } from "./with-org.ts";

// whoami and directory (agent-surfaces: The MCP tools; teams-and-roles: Bot
// users; design.md, Decisions this change rests on: D28 #56, #94). whoami
// names the user the call acts for, with the bot flag an admin sets, the teams
// they belong to, by key, and the install by its URL, TIEHALL_URL, and warns
// when the version of the Tiehall skill the call names is older than
// MINIMUM_SKILL_VERSION (agent-surfaces: The Claude Code plugin). directory lists the install's teams by key,
// with their names, their intake notes and the fields they require (agent-surfaces: Admins set a team's intake
// notes and required fields), and the registered APIs, each with its provider team and the teams declared as its
// consumers, as contract-change routing reads them, and its name, which an admin
// wrote, under untrusted; an unregistered API is not listed (contract-changes:
// Teams declare the APIs they consume). teams.get reads one team as directory lists it, by its current key or
// an earlier one, for its intake page (agent-surfaces: Team intake pages); a
// key no team has or had gets 404. All three only read, and every member may
// run them.
//
// directory answers a page at a time (agent-surfaces: The MCP tools;
// decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (39)): the teams by key, then the registered APIs by name, a page taking
// them in that order until it holds 50 teams or 50 APIs, or until the next
// would take it past the 32,000 characters that cap a page of get_request, its
// markdown and its structured content together, as the caller reads them. A
// page names the cursor of the next while more remain: the place after its
// last team or API, encoded, which only the install makes and reads, so a
// team or an API added or removed between pages moves no other one.

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
    const [row] = await context.tx.select(TEAM_COLUMNS).from(teams).where(and(eq(teams.orgId, context.orgId), eq(teams.id, found.id)));
    if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
    return listedTeam(row, await teamKeysById(context));
  }),

  [readDirectory.id]: defineHandler(readDirectory, async ({ cursor }, context) => {
    const after = placeOf(cursor);
    const teamsAfter: SQL[] = [eq(teams.orgId, context.orgId)];
    if (after?.kind === "team") teamsAfter.push(gt(teams.key, after.value));
    // One more than a page holds of each, which says whether more follow.
    const teamRows =
      after?.kind === "api"
        ? []
        : await context.tx
            .select(TEAM_COLUMNS)
            .from(teams)
            .where(and(...teamsAfter))
            .orderBy(asc(teams.key))
            .limit(DIRECTORY_PAGE_ITEMS + 1);
    const apisAfter: SQL[] = [eq(apis.orgId, context.orgId), isNull(apis.unregisteredAt)];
    if (after?.kind === "api") apisAfter.push(gt(apis.name, after.value));
    const apiRows = await context.tx
      .select({ id: apis.id, name: apis.name, providerId: teams.id, providerKey: teams.key })
      .from(apis)
      .innerJoin(teams, and(eq(teams.orgId, apis.orgId), eq(teams.id, apis.providerTeamId)))
      .where(and(...apisAfter))
      .orderBy(asc(apis.name))
      .limit(DIRECTORY_PAGE_ITEMS + 1);
    const keys = await teamKeysById(context);
    const reader: Reader = { teams: (await teamsOfMember(context, actingUserOf(context))).map(({ key }) => key) };
    let page: DirectoryPage = { teams: [], apis: [], next: null };
    /** The page with one more team or API, when it still fits; the first of a page always does. */
    const fitted = (more: DirectoryPage): boolean => {
      if (page.teams.length + page.apis.length > 0 && pageCharacters(more, reader) > PAGE_CHARACTERS) return false;
      page = more;
      return true;
    };
    for (const row of teamRows.slice(0, DIRECTORY_PAGE_ITEMS)) {
      if (!fitted({ ...page, teams: [...page.teams, listedTeam(row, keys)], next: cursorOf({ kind: "team", value: row.key }) })) break;
    }
    let more = teamRows.length > page.teams.length;
    if (!more) {
      for (const api of apiRows.slice(0, DIRECTORY_PAGE_ITEMS)) {
        const listed = { id: api.id, provider: { id: api.providerId, key: api.providerKey }, consumers: await consumersOf(context, api.id), untrusted: { name: api.name } };
        if (!fitted({ ...page, apis: [...page.apis, listed], next: cursorOf({ kind: "api", value: api.name }) })) break;
      }
      more = apiRows.length > page.apis.length;
    }
    return { ...page, next: more ? page.next : null };
  }),
};

/** A page of directory, as it answers. */
type DirectoryPage = DirectoryJson & { teams: ReturnType<typeof listedTeam>[]; next: string | null };

/** The characters of a page as its caller reads it: its markdown and its structured content together. */
function pageCharacters(page: DirectoryPage, reader: Reader): number {
  return createAgentView().markdown(directoryText(page, reader)).length + JSON.stringify(page).length;
}

/** A place in directory's order: after a team's key, or after a registered API's name, which comes after every team. */
interface Place {
  kind: "team" | "api";
  value: string;
}

/** The cursor of the page after this place. */
function cursorOf({ kind, value }: Place): string {
  return Buffer.from(`${kind === "team" ? "t" : "a"}:${value}`, "utf8").toString("base64url");
}

/** The place a cursor names; none for the first page. A cursor the install did not make is refused as input that fails the schema. */
function placeOf(cursor: string | undefined): Place | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^([ta]):(.{1,100})$/s.exec(decoded);
  if (match === null || Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
    const message = "The cursor is one that directory named as next.";
    throw new Refusal("invalid-input", message, { issues: [{ path: ["cursor"], message }] });
  }
  return { kind: match[1] === "t" ? "team" : "api", value: match[2] ?? "" };
}

/** The columns a team is listed from. */
const TEAM_COLUMNS = {
  id: teams.id,
  key: teams.key,
  name: teams.name,
  intakeNotes: teams.intakeNotes,
  intakeNotesWriterTeamIds: teams.intakeNotesWriterTeamIds,
  requiredFields: teams.requiredFields,
};

type TeamRow = { id: string; key: string; name: string; intakeNotes: string; intakeNotesWriterTeamIds: string[] | null; requiredFields: string[] };

/** The install's teams' current keys, by id. */
async function teamKeysById({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<Map<string, string>> {
  const rows = await tx.select({ id: teams.id, key: teams.key }).from(teams).where(eq(teams.orgId, orgId));
  return new Map(rows.map(({ id, key }) => [id, key]));
}

/** A team as directory and teams.get list it, the teams its notes' writer belonged to by their current keys, in order. */
function listedTeam(row: TeamRow, keys: ReadonlyMap<string, string>) {
  const writers =
    row.intakeNotesWriterTeamIds === null
      ? null
      : row.intakeNotesWriterTeamIds
          .flatMap((id) => {
            const key = keys.get(id);
            return key === undefined ? [] : [{ id, key }];
          })
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    id: row.id,
    key: row.key,
    requiredFields: row.requiredFields as IntakeField[],
    intakeNotesWrittenBy: writers,
    untrusted: { name: row.name, intakeNotes: row.intakeNotes },
  };
}
