import { DIRECTORY_PAGE_ITEMS, getTeam, PAGE_CHARACTERS, readDirectory, whoami, type IntakeField } from "@tiehall/catalog";
import { compareVersions, MINIMUM_SKILL_VERSION, Refusal, TEAM_KEY } from "@tiehall/core";
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
//
// A team or an API that does not fit whole on a page that begins with it, an
// API with several hundred consumers or a team whose intake notes' writer
// belonged to that many teams, is the one that a page ends inside, as the
// maintainer answered on 2026-10-12: the page takes as much of its list, the
// API's consumers or the team's intakeNotesWrittenBy, in the order of their
// keys, as fits, at least one, marks it as going on in the next page, and
// names the place after the last key it listed; the next page begins with the
// same team or API, marked as going on from the previous page, and the rest
// of its list as it stands when that page is read, after that key, so no
// consumer is left out. A team or an API that fits on a page of its own is
// never split: a page it would take past the cap ends before it. The last
// team or API of the directory is measured as its page answers, with no
// cursor, so one that fits on that last page is listed there whole. A team's
// intake notes are shown once, on the page that begins with it, and fenced by
// the teams that page lists for it (directoryText): as the reader's own team's
// text only when one of them is the reader's, and as another team's otherwise,
// as notes whose writer is unknown are, so a long list never makes another
// team's notes read as the reader's own; a later page names the team by its
// id and key, with the rest of its list, in its text and its structured
// content alike, so its name, its notes and its required fields are given
// once.

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
    const keys = await teamKeysById(context);
    const reader: Reader = { teams: (await teamsOfMember(context, actingUserOf(context))).map(({ key }) => key) };
    let page: DirectoryPage = { teams: [], apis: [], next: null };
    /**
     * Takes the team or API onto the page whole, or, as the first of the page, as much of its list as fits. The last
     * team or API of the directory is measured with no cursor, as the page that takes it answers.
     */
    const take = (candidate: Candidate, last: boolean): "taken" | "cut" | "full" => {
      const count = candidate.kind === "team" ? page.teams.length : page.apis.length;
      if (count >= DIRECTORY_PAGE_ITEMS) return "full";
      const whole = withEntry(page, candidate, candidate.entry, last ? null : candidate.after);
      const first = page.teams.length + page.apis.length === 0;
      if (pageCharacters(whole, reader) <= PAGE_CHARACTERS || (first && candidate.list.length <= 1)) {
        page = whole;
        return "taken";
      }
      if (!first) return "full";
      // The most of its list that fits, found by halving: at least one, and fewer than all, which do not fit.
      const part = (count: number): DirectoryPage => {
        const items = candidate.list.slice(0, count);
        return withEntry(page, candidate, candidate.cut(items), candidate.inside(items.at(-1)?.key ?? ""));
      };
      let fits = 1;
      let fails = candidate.list.length;
      while (fails - fits > 1) {
        const middle = Math.floor((fits + fails) / 2);
        if (pageCharacters(part(middle), reader) <= PAGE_CHARACTERS) fits = middle;
        else fails = middle;
      }
      page = part(fits);
      return "cut";
    };
    // The candidates hold one more than a page takes of each, besides the one it goes on with, which says whether more
    // follow: the last of them is the directory's last team, when no API is registered, or its last API, only when a
    // page can reach it, since a page that holds 50 of a kind ends before the 51st.
    let more = false;
    if (after?.kind !== "api" && after?.kind !== "consumers") {
      const candidates = await teamCandidates(context, after, keys);
      for (const [index, candidate] of candidates.entries()) {
        if (take(candidate, index === candidates.length - 1 && !(await anyApiRegistered(context))) !== "taken") {
          more = true;
          break;
        }
      }
    }
    // The APIs come after every team, so a page takes them only once it has taken the last team.
    if (!more) {
      const candidates = await apiCandidates(context, after);
      for (const [index, candidate] of candidates.entries()) {
        if (take(candidate, index === candidates.length - 1) !== "taken") {
          more = true;
          break;
        }
      }
    }
    return { ...page, next: more ? page.next : null };
  }),
};

/** A team as directory and teams.get list it. */
type ListedTeam = ReturnType<typeof listedTeam>;

/** A team as a page of directory lists it: whole, or, going on from the previous page, by its id and key with the rest of its list. */
type PagedTeam = ListedTeam | Pick<ListedTeam, "id" | "key" | "intakeNotesWrittenBy">;

/** A registered API as directory lists it. */
interface ListedApi {
  id: string;
  provider: { id: string; key: string };
  consumers: { id: string; key: string }[];
  untrusted: { name: string };
}

/** Whether a part of a team or an API goes on from the previous page, or in the next one; absent when it does not. */
interface Continued {
  continuedFromPreviousPage?: true;
  continuedOnNextPage?: true;
}

/** A page of directory, as it answers. */
type DirectoryPage = DirectoryJson & { teams: (PagedTeam & Continued)[]; apis: (ListedApi & Continued)[]; next: string | null };

/** A team as a list names it: a team's intakeNotesWrittenBy, or an API's consumers. */
interface ListedRef {
  id: string;
  key: string;
}

/** A team or an API a page may take: whole, with what remains of its list, or the part of its list that fits. */
interface CandidateOf<Kind extends "team" | "api", Entry> {
  kind: Kind;
  /** The whole of it that remains, marked when it goes on from the previous page. */
  entry: Entry & Continued;
  /** Its list, in the order of the teams' keys. */
  list: readonly ListedRef[];
  /** It with only these of its list, marked as going on in the next page. */
  cut(items: readonly ListedRef[]): Entry & Continued;
  /** The place after it. */
  after: Place;
  /** The place inside its list, after this team key. */
  inside(key: string): Place;
}

type Candidate = CandidateOf<"team", PagedTeam> | CandidateOf<"api", ListedApi>;

/** The page with this team or API added, whole or in part, naming this place as the next page's, or none after the last. */
function withEntry(page: DirectoryPage, candidate: Candidate, entry: Candidate["entry"], next: Place | null): DirectoryPage {
  const cursor = next === null ? null : cursorOf(next);
  return candidate.kind === "team"
    ? { ...page, teams: [...page.teams, entry as PagedTeam & Continued], next: cursor }
    : { ...page, apis: [...page.apis, entry as ListedApi & Continued], next: cursor };
}

/** Whether the install has a registered API, which follows every team. */
async function anyApiRegistered(context: OrgContext): Promise<boolean> {
  const [row] = await context.tx
    .select({ id: apis.id })
    .from(apis)
    .where(and(eq(apis.orgId, context.orgId), isNull(apis.unregisteredAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * A team as a page may take it, going on from the previous page or not: its
 * list is its intakeNotesWrittenBy. One that goes on is named by its id and
 * key, with the rest of its list, since the page that began with it gave its
 * name, its intake notes and its required fields, which are shown once.
 */
function teamCandidate(listed: ListedTeam, goesOn: boolean): Candidate {
  const from: Continued = goesOn ? { continuedFromPreviousPage: true } : {};
  const shown: PagedTeam = goesOn ? { id: listed.id, key: listed.key, intakeNotesWrittenBy: listed.intakeNotesWrittenBy } : listed;
  return {
    kind: "team",
    entry: { ...shown, ...from },
    list: listed.intakeNotesWrittenBy ?? [],
    cut: (items) => ({ ...shown, intakeNotesWrittenBy: [...items], ...from, continuedOnNextPage: true }),
    after: { kind: "team", team: listed.key },
    inside: (key) => ({ kind: "writers", team: listed.key, after: key }),
  };
}

/** A registered API as a page may take it, going on from the previous page or not: its list is its consumers. */
function apiCandidate(listed: ListedApi, goesOn: boolean): Candidate {
  const from: Continued = goesOn ? { continuedFromPreviousPage: true } : {};
  return {
    kind: "api",
    entry: { ...listed, ...from },
    list: listed.consumers,
    cut: (items) => ({ ...listed, consumers: [...items], ...from, continuedOnNextPage: true }),
    after: { kind: "api", api: listed.untrusted.name },
    inside: (key) => ({ kind: "consumers", api: listed.untrusted.name, after: key }),
  };
}

/**
 * The teams a page may take after this place: the team whose list it is
 * inside, with the rest of that list, when any remains, then one more than a
 * page holds of the teams after it by key.
 */
async function teamCandidates(context: OrgContext, after: Place | undefined, keys: ReadonlyMap<string, string>): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const conditions: SQL[] = [eq(teams.orgId, context.orgId)];
  if (after?.kind === "team" || after?.kind === "writers") conditions.push(gt(teams.key, after.team));
  if (after?.kind === "writers") {
    const [row] = await context.tx.select(TEAM_COLUMNS).from(teams).where(and(eq(teams.orgId, context.orgId), eq(teams.key, after.team)));
    const listed = row === undefined ? undefined : listedTeam(row, keys);
    const rest = listed?.intakeNotesWrittenBy?.filter(({ key }) => key > after.after) ?? [];
    if (listed !== undefined && rest.length > 0) candidates.push(teamCandidate({ ...listed, intakeNotesWrittenBy: rest }, true));
  }
  const rows = await context.tx
    .select(TEAM_COLUMNS)
    .from(teams)
    .where(and(...conditions))
    .orderBy(asc(teams.key))
    .limit(DIRECTORY_PAGE_ITEMS + 1);
  return [...candidates, ...rows.map((row) => teamCandidate(listedTeam(row, keys), false))];
}

/**
 * The registered APIs a page may take after this place: the API whose
 * consumers it is inside, with those after its key, when any remain, then one
 * more than a page holds of the APIs after it by name; after a team, every
 * API from the first.
 */
async function apiCandidates(context: OrgContext, after: Place | undefined): Promise<Candidate[]> {
  const registered = (...conditions: SQL[]) =>
    context.tx
      .select({ id: apis.id, name: apis.name, providerId: teams.id, providerKey: teams.key })
      .from(apis)
      .innerJoin(teams, and(eq(teams.orgId, apis.orgId), eq(teams.id, apis.providerTeamId)))
      .where(and(eq(apis.orgId, context.orgId), isNull(apis.unregisteredAt), ...conditions));
  type Row = Awaited<ReturnType<typeof registered>>[number];
  const listed = async (api: Row, afterKey?: string): Promise<ListedApi> => ({
    id: api.id,
    provider: { id: api.providerId, key: api.providerKey },
    consumers: await consumersOf(context, api.id, afterKey),
    untrusted: { name: api.name },
  });
  const candidates: Candidate[] = [];
  if (after?.kind === "consumers") {
    const [api] = await registered(eq(apis.name, after.api));
    const rest = api === undefined ? undefined : await listed(api, after.after);
    if (rest !== undefined && rest.consumers.length > 0) candidates.push(apiCandidate(rest, true));
  }
  const rows = await registered(...(after?.kind === "api" || after?.kind === "consumers" ? [gt(apis.name, after.api)] : []))
    .orderBy(asc(apis.name))
    .limit(DIRECTORY_PAGE_ITEMS + 1);
  for (const row of rows) candidates.push(apiCandidate(await listed(row), false));
  return candidates;
}

/** The characters of a page as its caller reads it: its markdown and its structured content together. */
function pageCharacters(page: DirectoryPage, reader: Reader): number {
  return createAgentView().markdown(directoryText(page, reader)).length + JSON.stringify(page).length;
}

/**
 * A place in directory's order: after a team's key; inside a team's
 * intakeNotesWrittenBy, after a team's key; after a registered API's name,
 * which comes after every team; or inside its consumers, after a team's key.
 */
type Place =
  | { kind: "team"; team: string }
  | { kind: "writers"; team: string; after: string }
  | { kind: "api"; api: string }
  | { kind: "consumers"; api: string; after: string };

/** A team key inside a cursor. */
const KEY = TEAM_KEY.source.slice(1, -1);

/** The forms of a decoded cursor, by the letter that begins it; a key never holds a colon, so the last colon ends a name. */
const PLACES: readonly [RegExp, (match: RegExpExecArray) => Place][] = [
  [/^t:(.{1,100})$/s, (match) => ({ kind: "team", team: match[1] ?? "" })],
  [new RegExp(`^w:(${KEY}):(${KEY})$`), (match) => ({ kind: "writers", team: match[1] ?? "", after: match[2] ?? "" })],
  [/^a:(.{1,100})$/s, (match) => ({ kind: "api", api: match[1] ?? "" })],
  [new RegExp(`^c:(.{1,100}):(${KEY})$`, "s"), (match) => ({ kind: "consumers", api: match[1] ?? "", after: match[2] ?? "" })],
];

/** The cursor of the page after this place. */
function cursorOf(place: Place): string {
  const decoded =
    place.kind === "team"
      ? `t:${place.team}`
      : place.kind === "writers"
        ? `w:${place.team}:${place.after}`
        : place.kind === "api"
          ? `a:${place.api}`
          : `c:${place.api}:${place.after}`;
  return Buffer.from(decoded, "utf8").toString("base64url");
}

/** The place a cursor names; none for the first page. A cursor the install did not make is refused as input that fails the schema. */
function placeOf(cursor: string | undefined): Place | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") === cursor) {
    for (const [form, place] of PLACES) {
      const match = form.exec(decoded);
      if (match !== null) return place(match);
    }
  }
  const message = "The cursor is one that directory named as next.";
  throw new Refusal("invalid-input", message, { issues: [{ path: ["cursor"], message }] });
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
