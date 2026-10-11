import { requestActivity } from "@tiehall/catalog";
import type { RequestState } from "@tiehall/core";
import { events, messages, oauthClients, requests, users, type Database } from "@tiehall/db";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { CLI_CLIENT_ID } from "./device-flow.ts";
import { cutName, eventLine, shownText, stateAfter, STATE_EVENT_TYPES, type ActorClient, type EventActor, type EventUser } from "./event-lines.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { resolveRequestKey } from "./request-keys.ts";
import type { OrgContext } from "./with-org.ts";

// requests.activity, the read behind a request's page's activity (web-ui: The
// request page shows who works on it and what happened; web-ui: What the live
// hall shows of the people and agents at work; design.md, Design: The request
// page's activity; D57 (15)). From the request's own domain events, through
// the index events_request_number, it reads the latest that an agent or a web
// session caused, which names who wrote on the request last; whether their
// agent is at work on it, which it is only while the request is in_progress
// and that write is an agent's under 10 minutes old; and the 20 latest, newest
// first, each in Tiehall's words (event-lines.ts) with who caused it and the
// state it left the request in, which the latest event that moved the request
// before them starts from; and who posted each message of its thread, named
// the same way. Events carry ids and never text, so the read holds
// no message's or packet's text; a removed member's call is refused before it
// runs, as every call is.

/** How many of a request's latest events the read lists. */
export const ACTIVITY_EVENTS = 20;

/** How long after an agent's write the agent counts as at work. */
export const AT_WORK_MS = 10 * 60_000;

type Reader = Pick<Database, "select">;

const EVENT_COLUMNS = {
  number: events.number,
  type: events.type,
  occurredAt: events.occurredAt,
  data: events.data,
  actorKind: events.actorKind,
  actorUserId: events.actorUserId,
  client: events.client,
  surface: events.surface,
};

/** The request's domain events, by the index on the request's id and the event's number; the class is written as the index's own predicate says it. */
function aboutTheRequest(orgId: string, requestId: string) {
  return and(eq(events.orgId, orgId), sql`${events.class} = 'domain'`, sql`(${events.data} ->> 'requestId') = ${requestId}`);
}

/**
 * The read's queries of the event log: the request's latest events, its latest
 * that an agent or a web session caused, and the latest that moved it before a
 * given event. The tests read their query plans.
 */
export function requestActivityQueries(db: Reader, orgId: string, requestId: string, before = Number.MAX_SAFE_INTEGER) {
  const latest = db.select(EVENT_COLUMNS).from(events).where(aboutTheRequest(orgId, requestId)).orderBy(desc(events.number)).limit(ACTIVITY_EVENTS);
  const lastWrite = db
    .select(EVENT_COLUMNS)
    .from(events)
    .where(and(aboutTheRequest(orgId, requestId), inArray(events.actorKind, ["agent", "web_session"])))
    .orderBy(desc(events.number))
    .limit(1);
  const lastMove = db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(and(aboutTheRequest(orgId, requestId), inArray(events.type, [...STATE_EVENT_TYPES]), lt(events.number, before)))
    .orderBy(desc(events.number))
    .limit(1);
  return [latest, lastWrite, lastMove] as const;
}

type EventRow = Awaited<ReturnType<typeof requestActivityQueries>[0]>[number];

/** The tiehall CLI's version in a client an event names, such as 0.4.0 in tiehall-cli/0.4.0; null when it names none. */
function cliVersionOf(client: string): string | null | undefined {
  if (client === CLI_CLIENT_ID) return null;
  return client.startsWith(`${CLI_CLIENT_ID}/`) ? client.slice(CLI_CLIENT_ID.length + 1) : undefined;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Names the actors of these events: the users they name, by login and bot
 * flag, and the agent clients, by the name each gave itself, without the
 * characters that hide or reverse text, and how the install knows it, read in
 * the call's transaction.
 */
export async function actorsOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, rows: readonly Pick<EventRow, "actorKind" | "actorUserId" | "client" | "surface">[]): Promise<(row: (typeof rows)[number]) => EventActor> {
  const userIds = [...new Set(rows.map(({ actorUserId }) => actorUserId).filter((id): id is string => id !== null))];
  const clientIds = [...new Set(rows.map(({ client }) => client).filter((client): client is string => client !== null && cliVersionOf(client) === undefined))];
  const named = new Map<string, EventUser>();
  if (userIds.length > 0) {
    const found = await tx
      .select({ id: users.id, login: users.githubLogin, bot: users.bot })
      .from(users)
      .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)));
    for (const { id, login, bot } of found) named.set(id, { id, login, kind: "human", bot });
  }
  const clients = new Map<string, { name: string | null; discovery: string | null }>();
  if (clientIds.length > 0) {
    const found = await tx
      .select({ clientId: oauthClients.clientId, name: oauthClients.name, discovery: oauthClients.clientDiscoveryId })
      .from(oauthClients)
      .where(and(eq(oauthClients.orgId, orgId), inArray(oauthClients.clientId, clientIds)));
    for (const { clientId, name, discovery } of found) clients.set(clientId, { name, discovery });
  }
  const clientOf = (client: string | null): ActorClient => {
    if (client === null) return { kind: "personal_access_token", host: null, version: null, unverified: false, untrusted: { name: null } };
    const version = cliVersionOf(client);
    if (version !== undefined) return { kind: "cli", host: null, version, unverified: false, untrusted: { name: null } };
    const known = clients.get(client);
    // The name without the characters that hide or reverse text, so it cannot turn the mark beside it round; a name of nothing else is no name.
    const shown = known?.name === null || known?.name === undefined ? "" : shownText(known.name);
    const name = shown.trim() === "" ? null : cutName(shown);
    const host = known?.discovery === "cimd" ? hostOf(client) : null;
    if (host !== null) return { kind: "metadata_document", host, version: null, unverified: false, untrusted: { name } };
    return { kind: "registered", host: null, version: null, unverified: true, untrusted: { name } };
  };
  return ({ actorKind, actorUserId, client, surface }) => {
    const user = actorUserId === null ? null : (named.get(actorUserId) ?? null);
    switch (actorKind) {
      case "agent":
        return { kind: "agent", user, client: clientOf(client) };
      case "web_session":
        return { kind: "web", user, client: null };
      case "integration":
        return { kind: surface === "jira" ? "jira" : "github", user: null, client: null };
      case "operator":
        return { kind: "operator", user: null, client: null };
      default:
        return { kind: "tiehall", user: null, client: null };
    }
  };
}

export const REQUEST_ACTIVITY_HANDLERS: Handlers = {
  [requestActivity.id]: defineHandler(requestActivity, async ({ key }, context) => {
    const { requestId, key: current } = await resolveRequestKey(context, key);
    const [request] = await context.tx
      .select({ state: requests.state })
      .from(requests)
      .where(and(eq(requests.orgId, context.orgId), eq(requests.id, requestId)));
    if (request === undefined) throw new Error("A resolved request key names no request.");
    const state = request.state as RequestState;
    const [latestQuery, lastWriteQuery] = requestActivityQueries(context.tx, context.orgId, requestId);
    const latest = await latestQuery;
    const [lastWrite] = await lastWriteQuery;
    // The state the request was in before the oldest of the latest events, from the latest event that moved it before then.
    const oldest = latest.at(-1);
    const [, , lastMoveQuery] = requestActivityQueries(context.tx, context.orgId, requestId, oldest?.number ?? 0);
    const [lastMove] = oldest === undefined ? [] : await lastMoveQuery;
    let before: RequestState = lastMove === undefined ? "open" : stateAfter(lastMove.type, lastMove.data as Record<string, unknown>, "open");
    const states = new Map<number, RequestState>();
    for (const row of [...latest].reverse()) {
      before = stateAfter(row.type, row.data as Record<string, unknown>, before);
      states.set(row.number, before);
    }
    // Who posted each message of the thread, which the page names beside each message.
    const posted = await context.tx
      .select({ id: messages.id, actorKind: messages.actorKind, actorUserId: messages.actorUserId, client: messages.client, surface: messages.surface })
      .from(messages)
      .where(and(eq(messages.orgId, context.orgId), eq(messages.requestId, requestId)))
      .orderBy(asc(messages.number));
    const actorOf = await actorsOf(context, [...latest, ...(lastWrite === undefined ? [] : [lastWrite]), ...posted]);
    const now = context.now();
    return {
      now: now.toISOString(),
      request: { id: requestId, key: current, state },
      lastWrite: lastWrite === undefined ? null : { at: lastWrite.occurredAt.toISOString(), actor: actorOf(lastWrite) },
      agentAtWork: state === "in_progress" && lastWrite?.actorKind === "agent" && now.getTime() - lastWrite.occurredAt.getTime() < AT_WORK_MS,
      events: latest.map((row) => ({
        number: row.number,
        type: row.type,
        at: row.occurredAt.toISOString(),
        state: states.get(row.number) ?? state,
        line: eventLine(row.type, row.data as Record<string, unknown>),
        actor: actorOf(row),
      })),
      authors: posted.map((row) => ({ messageId: row.id, actor: actorOf(row) })),
    };
  }),
};
