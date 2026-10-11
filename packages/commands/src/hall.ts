import { readHallState, waitForHall } from "@tiehall/catalog";
import { formatRequestKey, isTerminalState, Refusal, type RequestState } from "@tiehall/core";
import { users } from "@tiehall/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { eventLine } from "./event-lines.ts";
import { held, RECHECK_MS, shuttingDown } from "./events-wait.ts";
import { defineHandler, definePreparedHandler, type Handlers, type PrepareContext } from "./execute.ts";
import { actorsOf, AT_WORK_MS } from "./request-activity.ts";
import { teamOfKey } from "./request-keys.ts";
import { shutdownSignal } from "./shutdown.ts";
import type { OrgContext } from "./with-org.ts";

// The live hall's reads (web-ui: The live hall; web-ui: What the live hall
// shows of the people and agents at work; activity-log: Security events are
// shown to admins only; design.md, Design: The live hall; D57 (11), (13)).
// hall.state reads, in one read-only transaction: the cursor first, the number
// of the newest domain event about a request, so the page's wait, which starts
// after it, misses nothing the other reads leave out, and at worst brings an
// event they hold already, which the page keeps once; every team with its
// live requests by state, by grouping, and those done within the last 24
// hours, from the domain events within that time; the lines between teams, by
// grouping; the 200 most recently changed live requests, each one's last
// change through events_request_number; the people and agents at work, the
// latest event of each user, actor kind and client among the events of the
// last 10 minutes, through events_domain_occurred_at, recorded as agent or
// web_session only, since only those name someone at work, leaving out the
// state changes, which only follow from another of their events, such as a
// blocking question; and the 50 latest domain events about requests, by the
// event log's key in descending order. Events are named as the request page's
// timeline names them (event-lines.ts, request-activity.ts). Every read takes
// domain events only, so a security event never reaches it, and events carry
// ids, never text, so no message's or packet's text does either. `team`
// narrows the lines, the requests, the people and agents at work and the feed
// to the requests from or to that team, by their current teams, and `agents`
// the people at work and the feed to events recorded as agent; the teams are
// always every team.

/** How many live requests the hall lists, the most recently changed first. */
export const HALL_REQUESTS = 200;

/** How many of the latest events the hall's feed lists. */
export const HALL_FEED = 50;

/** How many of the people and agents at work the map shows. */
export const ON_THE_MAP = 12;

/** How long after a request reached done a team's count of done requests holds it. */
export const DONE_WINDOW_MS = 24 * 60 * 60_000;

/** How a member narrowed the hall: to the requests from or to one team, by its id, and to what agents did. */
export interface HallNarrowing {
  teamId: string | undefined;
  agents: boolean;
}

/** The states that are not terminal, as SQL. */
const LIVE = sql.raw("('open', 'claimed', 'in_progress', 'needs_info')");

/** A time as the answers carry it, ISO 8601 in UTC with milliseconds, as SQL. */
function iso(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The columns of an event the hall names: its number, time, type and data, and who caused it. */
const EVENT_COLUMNS = sql`e.number, ${iso(sql`e.occurred_at`)} AS at, e.type, e.data, e.actor_kind, e.actor_user_id, e.client, e.surface, e.team_id`;

/** Counts of requests r by each state that is not terminal, as SQL. */
const LIVE_COUNTS = sql.raw(
  "count(r.id) FILTER (WHERE r.state = 'open')::int AS open, count(r.id) FILTER (WHERE r.state = 'claimed')::int AS claimed, count(r.id) FILTER (WHERE r.state = 'in_progress')::int AS in_progress, count(r.id) FILTER (WHERE r.state = 'needs_info')::int AS needs_info",
);

/** The requests r from or to the team the hall is narrowed to, as a further condition; none when it is not narrowed. */
function onTheTeam(teamId: string | undefined): SQL {
  return teamId === undefined ? sql`` : sql` AND (r.requesting_team_id = ${teamId} OR r.target_team_id = ${teamId})`;
}

/** The events e about a request from or to the team the hall is narrowed to, by the request's current teams. */
function eventOnTheTeam(teamId: string | undefined): SQL {
  return teamId === undefined
    ? sql``
    : sql` AND EXISTS (SELECT 1 FROM requests r WHERE r.org_id = e.org_id AND r.id::text = (e.data ->> 'requestId')${onTheTeam(teamId)})`;
}

/** The events e an agent caused, when the hall is narrowed to agents. */
function byAgents(agents: boolean): SQL {
  return agents ? sql` AND e.actor_kind = 'agent'` : sql``;
}

/**
 * The requests r that match the condition, with the time of each one's latest
 * domain event, through events_request_number, the most recently changed
 * first, at most `limit` of them. The latest event is read in the index's own
 * order, number DESC NULLS LAST, so the index gives it at once.
 */
export function requestLinesQuery(orgId: string, where: SQL, limit?: number): SQL {
  return sql`SELECT r.id, r.number, r.title, r.state, r.requesting_team_id AS from_id, r.target_team_id AS to_id, r.claimant_user_id, r.needs_human,
      ${iso(sql`coalesce(last.occurred_at, r.created_at)`)} AS changed_at
    FROM requests r
    LEFT JOIN LATERAL (
      SELECT e.occurred_at FROM events e
       WHERE e.org_id = ${orgId} AND e.class = 'domain' AND (e.data ->> 'requestId') = r.id::text
       ORDER BY e.number DESC NULLS LAST LIMIT 1
    ) last ON true
    WHERE r.org_id = ${orgId} AND ${where}
    ORDER BY coalesce(last.occurred_at, r.created_at) DESC, r.id${limit === undefined ? sql`` : sql` LIMIT ${limit}`}`;
}

/** The hall's queries of the state, which the tests read the query plans of. */
export function hallQueries(orgId: string, now: Date, narrowed: HallNarrowing) {
  const since = new Date(now.getTime() - AT_WORK_MS).toISOString();
  const dayAgo = new Date(now.getTime() - DONE_WINDOW_MS).toISOString();
  return {
    cursor: sql`SELECT e.number FROM events e WHERE e.org_id = ${orgId} AND e.class = 'domain' AND (e.data ->> 'requestId') IS NOT NULL ORDER BY e.number DESC LIMIT 1`,
    teams: sql`SELECT t.id, t.key, t.name, ${LIVE_COUNTS}
      FROM teams t
      LEFT JOIN requests r ON r.org_id = t.org_id AND r.target_team_id = t.id AND r.state IN ${LIVE}
      WHERE t.org_id = ${orgId}
      GROUP BY t.id, t.key, t.name
      ORDER BY t.key`,
    done: sql`SELECT r.target_team_id AS team_id, count(DISTINCT r.id)::int AS done
      FROM events e
      JOIN requests r ON r.org_id = e.org_id AND r.id::text = (e.data ->> 'requestId')
      WHERE e.org_id = ${orgId} AND e.class = 'domain' AND e.occurred_at > ${dayAgo}::timestamptz
        AND e.type = 'request.state_changed' AND (e.data ->> 'state') = 'done' AND r.state = 'done'
      GROUP BY r.target_team_id`,
    lines: sql`SELECT r.requesting_team_id AS from_id, r.target_team_id AS to_id, ${LIVE_COUNTS}
      FROM requests r
      WHERE r.org_id = ${orgId} AND r.state IN ${LIVE}${onTheTeam(narrowed.teamId)}
      GROUP BY r.requesting_team_id, r.target_team_id`,
    requestLines: requestLinesQuery(orgId, sql`r.state IN ${LIVE}${onTheTeam(narrowed.teamId)}`, HALL_REQUESTS),
    feed: sql`SELECT ${EVENT_COLUMNS}
      FROM events e
      WHERE e.org_id = ${orgId} AND e.class = 'domain' AND (e.data ->> 'requestId') IS NOT NULL${byAgents(narrowed.agents)}${eventOnTheTeam(narrowed.teamId)}
      ORDER BY e.number DESC
      LIMIT ${HALL_FEED}`,
    atWork: sql`SELECT DISTINCT ON (e.actor_user_id, e.actor_kind, coalesce(e.client, '')) ${EVENT_COLUMNS}
      FROM events e
      WHERE e.org_id = ${orgId} AND e.class = 'domain' AND e.occurred_at > ${since}::timestamptz
        AND e.actor_kind IN ('agent', 'web_session') AND e.type <> 'request.state_changed'
        AND (e.data ->> 'requestId') IS NOT NULL${byAgents(narrowed.agents)}${eventOnTheTeam(narrowed.teamId)}
      ORDER BY e.actor_user_id, e.actor_kind, coalesce(e.client, ''), e.number DESC`,
  };
}

/** An event as the hall's queries read it. */
export interface EventRow extends Record<string, unknown> {
  number: string | number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  actor_kind: string;
  actor_user_id: string | null;
  client: string | null;
  surface: string | null;
  team_id: string | null;
}

interface CountRow extends Record<string, unknown> {
  open: number;
  claimed: number;
  in_progress: number;
  needs_info: number;
}

interface TeamRow extends CountRow {
  id: string;
  key: string;
  name: string;
}

interface LineRow extends CountRow {
  from_id: string;
  to_id: string;
}

/** A request as requestLinesQuery reads it. */
export interface RequestRow extends Record<string, unknown> {
  id: string;
  number: number;
  title: string;
  state: RequestState;
  from_id: string;
  to_id: string;
  claimant_user_id: string | null;
  needs_human: boolean;
  changed_at: string;
}

/** A team as the hall names it. */
export interface TeamRef {
  id: string;
  key: string;
}

async function rowsOf<T extends Record<string, unknown>>(context: Pick<OrgContext, "tx">, query: SQL): Promise<T[]> {
  return (await context.tx.execute<T>(query)).rows as T[];
}

const countsOf = ({ open, claimed, in_progress, needs_info }: CountRow) => ({ open, claimed, in_progress, needs_info });

/** Every team of the install, by key, with its live requests by state and those done within the last 24 hours. */
export async function hallTeams(context: Pick<OrgContext, "tx" | "orgId">, now: Date) {
  const queries = hallQueries(context.orgId, now, { teamId: undefined, agents: false });
  const rows = await rowsOf<TeamRow>(context, queries.teams);
  const done = new Map((await rowsOf<{ team_id: string; done: number }>(context, queries.done)).map(({ team_id, done }) => [team_id, done]));
  return rows.map((row) => ({ id: row.id, key: row.key, counts: countsOf(row), doneLastDay: done.get(row.id) ?? 0, untrusted: { name: row.name } }));
}

/** The lines between teams, by the keys of their teams. */
export async function hallLines(context: Pick<OrgContext, "tx" | "orgId">, now: Date, narrowed: HallNarrowing, teams: ReadonlyMap<string, TeamRef>) {
  const rows = await rowsOf<LineRow>(context, hallQueries(context.orgId, now, narrowed).lines);
  return rows
    .flatMap((row) => {
      const from = teams.get(row.from_id);
      const to = teams.get(row.to_id);
      return from === undefined || to === undefined ? [] : [{ from: refOf(from), to: refOf(to), counts: countsOf(row) }];
    })
    .sort((a, b) => a.from.key.localeCompare(b.from.key) || a.to.key.localeCompare(b.to.key));
}

function refOf({ id, key }: TeamRef): TeamRef {
  return { id, key };
}

/** A request as the hall names it, from its row, with its key from its target team's current key; undefined for a team the hall does not know. */
function requestRefOf(row: Pick<RequestRow, "id" | "number" | "title" | "state" | "from_id" | "to_id" | "needs_human">, teams: ReadonlyMap<string, TeamRef>) {
  const from = teams.get(row.from_id);
  const to = teams.get(row.to_id);
  if (from === undefined || to === undefined) return undefined;
  return { id: row.id, key: formatRequestKey(to.key, row.number), state: row.state, from: refOf(from), to: refOf(to), needsHuman: row.needs_human, untrusted: { title: row.title } };
}

/** The requests the rows read, as the hall lists them, with their claimants by login and bot flag. */
export async function hallRequests(context: Pick<OrgContext, "tx" | "orgId">, rows: readonly RequestRow[], teams: ReadonlyMap<string, TeamRef>) {
  const claimantIds = [...new Set(rows.map(({ claimant_user_id }) => claimant_user_id).filter((id): id is string => id !== null))];
  const claimants = new Map<string, { id: string; login: string; kind: "human"; bot: boolean }>();
  if (claimantIds.length > 0) {
    const found = await context.tx
      .select({ id: users.id, login: users.githubLogin, bot: users.bot })
      .from(users)
      .where(and(eq(users.orgId, context.orgId), inArray(users.id, claimantIds)));
    for (const { id, login, bot } of found) claimants.set(id, { id, login, kind: "human", bot });
  }
  return rows.flatMap((row) => {
    const ref = requestRefOf(row, teams);
    if (ref === undefined) return [];
    return [{ ...ref, claimant: row.claimant_user_id === null ? null : (claimants.get(row.claimant_user_id) ?? null), changedAt: row.changed_at }];
  });
}

/**
 * The events the rows read, as the hall's feed and its people at work say
 * them: what happened in Tiehall's words, who caused it, the team they acted
 * for and the request it was about, as it is now. An event about a request
 * the install does not hold is left out.
 */
export async function hallEvents(context: Pick<OrgContext, "tx" | "orgId">, rows: readonly EventRow[], teams: ReadonlyMap<string, TeamRef>) {
  const ids = [...new Set(rows.map(({ data }) => data["requestId"]).filter((id): id is string => typeof id === "string"))];
  const requests = new Map<string, NonNullable<ReturnType<typeof requestRefOf>>>();
  if (ids.length > 0) {
    const found = await rowsOf<RequestRow>(
      context,
      sql`SELECT r.id, r.number, r.title, r.state, r.requesting_team_id AS from_id, r.target_team_id AS to_id, r.needs_human
            FROM requests r WHERE r.org_id = ${context.orgId} AND r.id::text IN ${ids}`,
    );
    for (const row of found) {
      const ref = requestRefOf(row, teams);
      if (ref !== undefined) requests.set(row.id, ref);
    }
  }
  const named = rows.map((row) => ({ actorKind: row.actor_kind, actorUserId: row.actor_user_id, client: row.client, surface: row.surface }));
  const actorOf = await actorsOf(context, named);
  return rows.flatMap((row, index) => {
    const request = requests.get(String(row.data["requestId"]));
    const actorRow = named[index];
    if (request === undefined || actorRow === undefined) return [];
    const team = row.team_id === null ? undefined : teams.get(row.team_id);
    return [{ seq: Number(row.number), at: row.at, type: row.type, line: eventLine(row.type, row.data), actor: actorOf(actorRow), team: team === undefined ? null : refOf(team), request }];
  });
}

/** The team a hall is narrowed to, by its key or a key it had before a rename; 404 when no team has had it. */
export async function narrowingOf(context: OrgContext, input: { team?: string | undefined; agents?: boolean | undefined }): Promise<HallNarrowing> {
  if (input.team === undefined) return { teamId: undefined, agents: input.agents === true };
  const team = await teamOfKey(context, input.team);
  if (team === undefined) throw new Refusal("record-not-found", "There is no such team.");
  return { teamId: team.id, agents: input.agents === true };
}

/** What the live hall shows now, narrowed as asked (readHallState's output). */
export async function readHall(context: OrgContext, now: Date, narrowed: HallNarrowing) {
  const queries = hallQueries(context.orgId, now, narrowed);
  // The cursor first: whatever commits after it is the wait's to bring.
  const [newest] = await rowsOf<{ number: string | number }>(context, queries.cursor);
  const teams = await hallTeams(context, now);
  const byId = new Map(teams.map(({ id, key, untrusted }) => [id, { id, key, name: untrusted.name }]));
  const lines = await hallLines(context, now, narrowed, byId);
  const requestLines = await hallRequests(context, await rowsOf<RequestRow>(context, queries.requestLines), byId);
  const feed = await hallEvents(context, await rowsOf<EventRow>(context, queries.feed), byId);
  const atWork = await hallAtWork(context, now, narrowed, byId);
  return { now: now.toISOString(), cursor: newest === undefined ? 0 : Number(newest.number), teams, lines, requestLines, atWork, feed };
}

/** The people and agents at work now, the most recent first, the first 12 marked for the map. */
export async function hallAtWork(context: Pick<OrgContext, "tx" | "orgId">, now: Date, narrowed: HallNarrowing, teams: ReadonlyMap<string, TeamRef>) {
  const rows = (await rowsOf<EventRow>(context, hallQueries(context.orgId, now, narrowed).atWork)).sort((a, b) => Number(b.number) - Number(a.number));
  const data = new Map(rows.map((row) => [Number(row.number), row.data]));
  const named = await hallEvents(context, rows, teams);
  return named.map(({ seq, actor, at, type, line, team, request }, index) => {
    const asked = data.get(seq);
    const waiting = type === "request.message_posted" && asked?.["kind"] === "question" && asked["blocking"] === true && request.state === "needs_info";
    return { actor, at, type, line, team, request, waiting, onMap: index < ON_THE_MAP };
  });
}

// The live hall's long-poll (web-ui: The live hall's reads and its
// long-poll; requester-loop: No push paths other than the hooks; design.md,
// Design: The live hall; D57 (12)). hall.wait holds the call in the step
// execute() runs before the call's transaction, as the API's wait does
// (events-wait.ts), so no connection or transaction is held while it waits:
// it takes a wake-up (event-wakeups.ts), reads in a short read-only
// transaction whether a domain event about a request came after the cursor,
// and if none came, holds until the wake-up, the hold of 25 seconds, its own
// setting, or the shutdown, reading again on its own every 5 seconds should a
// wake-up be lost. Once woken it waits 250 milliseconds more, so a burst of
// events comes in one answer, and reads again. A security event sends no
// wake-up, so it never ends the wait. The answer is read in the call's own
// transaction: the new events, at most 50 or else only that the page must read
// the state again; the events the narrowed feed shows; every request they
// name, as it is now, marked terminal once it left the hall, by its state or,
// in a hall narrowed to a team, by no longer running from or to that team, as
// after a reassignment, which gives it a new key while its id stays; every
// team, the narrowed lines and the people and agents at work, as hall.state
// reads them; and the cursor, the newest new event, or the one given. While
// the app shuts down it ends at once with 503 and Retry-After: 0.

/** How long the live hall's wait holds when no event comes: 25 seconds, under the idle time after which common proxies end an answer. */
export const HALL_HOLD_MS = 25_000;

/** How long a woken wait waits before it reads, so a burst of events comes in one answer. */
export const GATHER_MS = 250;

/** Whether a domain event about a request came after the cursor. */
async function eventAfter(context: Pick<OrgContext, "tx" | "orgId">, after: number): Promise<boolean> {
  const rows = await rowsOf<{ found: number }>(
    context,
    sql`SELECT 1 AS found FROM events e WHERE e.org_id = ${context.orgId} AND e.number > ${after} AND e.class = 'domain' AND (e.data ->> 'requestId') IS NOT NULL LIMIT 1`,
  );
  return rows.length > 0;
}

/** Waits, outside any transaction, until a domain event about a request comes after the cursor, the hold ends or the app shuts down. */
async function hallWaitStep({ after, team }: { after: number; team?: string | undefined }, context: PrepareContext): Promise<{ found: boolean }> {
  const shutdown = context.waits?.shutdown ?? shutdownSignal();
  if (shutdown.aborted) throw shuttingDown();
  // A team that does not exist is refused before the wait holds, not once it ends.
  if (team !== undefined) await context.read((read) => narrowingOf(read, { team }));
  const deadline = Date.now() + (context.waits?.hallHoldMs ?? HALL_HOLD_MS);
  const wakeups = context.waits?.wakeups;
  await wakeups?.ready();
  for (;;) {
    const wake = wakeups?.next();
    try {
      if (await context.read((read) => eventAfter(read, after))) return { found: true };
      // A shutdown that began while the wait read, between its holds, ends it as one that comes while it holds does.
      if (shutdown.aborted) throw shuttingDown();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { found: false };
      const outcome = await held(wake?.woken, Math.min(remaining, RECHECK_MS), shutdown);
      if (outcome === "shutdown") throw shuttingDown();
      if (outcome === "woken" && (await held(undefined, GATHER_MS, shutdown)) === "shutdown") throw shuttingDown();
    } finally {
      wake?.cancel();
    }
  }
}

/** Whether a request runs from or to the team the hall is narrowed to; every request does when it is not narrowed. */
function onTheNarrowedTeam(request: { from: TeamRef; to: TeamRef }, teamId: string | undefined): boolean {
  return teamId === undefined || request.from.id === teamId || request.to.id === teamId;
}

/** What changed after the cursor, read in the call's transaction (waitForHall's output). */
export async function readHallChange(context: OrgContext, now: Date, after: number, narrowed: HallNarrowing) {
  const rows = await rowsOf<EventRow>(
    context,
    sql`SELECT ${EVENT_COLUMNS} FROM events e
      WHERE e.org_id = ${context.orgId} AND e.number > ${after} AND e.class = 'domain' AND (e.data ->> 'requestId') IS NOT NULL
      ORDER BY e.number LIMIT ${HALL_FEED + 1}`,
  );
  if (rows.length > HALL_FEED) {
    const [newest] = await rowsOf<{ number: string | number }>(context, hallQueries(context.orgId, now, narrowed).cursor);
    return { now: now.toISOString(), cursor: Number(newest?.number ?? after), reload: true, events: [], requestLines: [], teams: [], lines: [], atWork: [] };
  }
  const teams = await hallTeams(context, now);
  const byId = new Map(teams.map(({ id, key, untrusted }) => [id, { id, key, name: untrusted.name }]));
  const named = await hallEvents(context, rows, byId);
  const events = named.filter(({ actor, request }) => (!narrowed.agents || actor.kind === "agent") && onTheNarrowedTeam(request, narrowed.teamId));
  const ids = [...new Set(named.map(({ request }) => request.id))];
  const changed = ids.length === 0 ? [] : await hallRequests(context, await rowsOf<RequestRow>(context, requestLinesQuery(context.orgId, sql`r.id::text IN ${ids}`)), byId);
  const requestLines = changed.map((line) => ({ ...line, terminal: isTerminalState(line.state) || !onTheNarrowedTeam(line, narrowed.teamId) }));
  const lines = await hallLines(context, now, narrowed, byId);
  const atWork = await hallAtWork(context, now, narrowed, byId);
  const last = rows.at(-1);
  return { now: now.toISOString(), cursor: last === undefined ? after : Number(last.number), reload: false, events, requestLines, teams, lines, atWork };
}

export const HALL_HANDLERS: Handlers = {
  [readHallState.id]: defineHandler(readHallState, async (input, context) => readHall(context, context.now(), await narrowingOf(context, input))),
  [waitForHall.id]: definePreparedHandler(waitForHall, hallWaitStep, async (input, context) =>
    readHallChange(context, context.now(), input.after, await narrowingOf(context, input)),
  ),
};
