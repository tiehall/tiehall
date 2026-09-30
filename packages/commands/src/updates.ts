import { readInboxUpdates, readUpdates, type update, type updatesPage } from "@tiehall/catalog";
import { requests } from "@tiehall/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { acknowledgeUpTo, cursorOf, readerOf } from "./event-reads.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import { requestViews, type RequestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// The pull readers' updates (requester-loop: The pull readers; requester-loop:
// Pull is the contract; requester-loop: What whats_new covers; requests: Read
// cursors move only on acknowledgement; requests: Readers get only domain
// events they may see; design.md, Decisions this change rests on: D28 #58,
// #60; D29 (5)). An update is a domain event on a request in the reader's
// scope, which is decided at the time of the read:
// - whats_new's scope, which `tiehall updates` and the hooks read too: every
//   event on a request whose requesting user is the user, whose claim the user
//   holds, or for which the user is accountable, meaning the user is the
//   accountable human of anything recorded on it, such as a message, a claim
//   or a proposal; and the opening of a request addressed to one of the
//   user's teams, or its reassignment to one, which is how a request becomes
//   new to a team, without the events that follow either;
// - the web inbox's update feed: whats_new's scope, plus every event on a
//   request whose requesting team is one of the user's teams.
// Events on every other request stay out, though every member may open those
// requests. Security events are never updates, an admin's included: only
// domain events are read. Reading moves nothing; the reader acknowledges an
// update by its number, which moves its own cursor, one per user and client
// (event-reads.ts), up to it and never back, and the next read follows it.

/** Whose updates a reader serves: whats_new's, or the web inbox's update feed's, which adds the user's teams' requests. */
export type UpdateScope = "whats_new" | "web_inbox";

/** How many updates a page holds, unless the reader asks for fewer. */
export const UPDATES_PAGE_SIZE = 25;

export type UpdateView = z.input<typeof update>;
export type UpdatesPage = z.input<typeof updatesPage>;

/** An event as the scope query reads it. */
interface ScopedEvent {
  number: number;
  type: string;
  occurredAt: Date;
  data: Record<string, string | number | boolean>;
}

/** The ids of the teams the user belongs to now, as text, for comparing with the ids events carry. */
function teamsOf(orgId: string, userId: string): SQL {
  return sql`SELECT tm.team_id::text FROM team_members tm WHERE tm.org_id = ${orgId} AND tm.user_id = ${userId}`;
}

/**
 * The ids, as text, of the requests whose events are all the user's updates:
 * those the user opened, holds the claim of, or is the accountable human of
 * anything recorded on, and, for the web inbox, those requested by one of the
 * user's teams.
 */
function requestsOf(orgId: string, userId: string, scope: UpdateScope): SQL {
  const theirs = sql`
      SELECT r.id::text FROM requests r
       WHERE r.org_id = ${orgId} AND (r.requesting_user_id = ${userId} OR r.claimant_user_id = ${userId})
      UNION
      SELECT p.request_id::text FROM proposals p WHERE p.org_id = ${orgId} AND p.accountable_user_id = ${userId}
      UNION
      SELECT a.data->>'requestId' FROM events a
       WHERE a.org_id = ${orgId} AND a.class = 'domain' AND a.actor_user_id = ${userId} AND a.data->>'requestId' IS NOT NULL`;
  if (scope === "whats_new") return theirs;
  return sql`${theirs}
      UNION
      SELECT r.id::text FROM requests r WHERE r.org_id = ${orgId} AND r.requesting_team_id::text IN (${teamsOf(orgId, userId)})`;
}

/** The user's updates after a number, oldest first, at most `limit` of them, and whether more follow. */
export async function updatesAfter(
  { tx, orgId }: OrgContext,
  { userId, scope, after, limit }: { userId: string; scope: UpdateScope; after: number; limit: number },
): Promise<{ events: ScopedEvent[]; more: boolean }> {
  const teams = teamsOf(orgId, userId);
  const { rows } = await tx.execute<{ number: string | number; type: string; occurred_at: Date | string; data: ScopedEvent["data"] }>(sql`
    SELECT e.number, e.type, e.occurred_at, e.data
      FROM events e
     WHERE e.org_id = ${orgId} AND e.class = 'domain' AND e.number > ${after}
       AND (
         e.data->>'requestId' IN (${requestsOf(orgId, userId, scope)})
         OR (e.type = 'request.opened' AND e.data->>'targetTeamId' IN (${teams}))
         OR (e.type = 'request.reassigned' AND e.data->>'teamId' IN (${teams}))
       )
     ORDER BY e.number
     LIMIT ${limit + 1}`);
  const events = rows.map((row) => ({
    number: Number(row.number),
    type: row.type,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
    data: row.data,
  }));
  return { events: events.slice(0, limit), more: events.length > limit };
}

/** A page of the user's updates as the pull readers answer it, each with its request, and the requests they are about. */
export async function updatesPageOf(
  context: OrgContext,
  { events, more, cursor, installUrl }: { events: readonly ScopedEvent[]; more: boolean; cursor: number; installUrl: string },
): Promise<UpdatesPage> {
  const ids = [...new Set(events.map(({ data }) => data["requestId"]).filter((id): id is string => typeof id === "string"))];
  const rows = ids.length === 0 ? [] : await context.tx.select().from(requests).where(and(eq(requests.orgId, context.orgId), inArray(requests.id, ids)));
  const views = await requestViews(context, rows);
  const byId = new Map(views.map((view) => [view.id, view]));
  const origin = new URL(installUrl).origin;
  return {
    events: events.map(({ number, type, occurredAt, data }) => {
      const view = byId.get(String(data["requestId"]));
      if (view === undefined) throw new Error("An update names a request the install does not have.");
      const { key } = view;
      return {
        number,
        type,
        occurredAt: occurredAt.toISOString(),
        data,
        request: { id: view.id, key, url: `${origin}/${key}`, targetTeam: view.targetTeam },
      };
    }),
    // In the order the updates first name them.
    "requests": ids.map((id) => byId.get(id)).filter((view): view is RequestView => view !== undefined),
    cursor,
    more,
  };
}

/**
 * A pull reader's answer for the caller's client: its cursor moved up to
 * `acknowledge` first, when given, then the updates in the scope after it.
 */
export async function readUpdatesFor(
  context: HandlerContext,
  scope: UpdateScope,
  { acknowledge, limit }: { acknowledge?: number | undefined; limit?: number | undefined },
): Promise<UpdatesPage> {
  const userId = actingUserOf(context);
  const reader = readerOf(context.caller);
  const cursor = acknowledge === undefined ? await cursorOf(context, userId, reader) : await acknowledgeUpTo(context, userId, reader, acknowledge);
  const installUrl = context.url;
  if (installUrl === undefined) throw new Error("The pull readers name each request's URL, so they run only where the install's URL is known.");
  const { events, more } = await updatesAfter(context, { userId, scope, after: cursor, limit: limit ?? UPDATES_PAGE_SIZE });
  return updatesPageOf(context, { events, more, cursor, installUrl });
}

export const UPDATE_HANDLERS: Handlers = {
  [readUpdates.id]: defineHandler(readUpdates, (input, context) => readUpdatesFor(context, "whats_new", input)),
  // The web UI reads as the web session, whose client is the web inbox, so it reads and moves the web inbox's own cursor.
  [readInboxUpdates.id]: defineHandler(readInboxUpdates, (input, context) => readUpdatesFor(context, "web_inbox", input)),
};
