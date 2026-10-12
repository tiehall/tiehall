import { acknowledgeEvents, readEvents } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { events, eventSequence, readCursors } from "@tiehall/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Caller } from "./caller.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// Reading the event log with a cursor per user and client (requests: Read
// cursors move only on acknowledgement; requests: Events carry ids, not
// bodies; design.md, Design rules: Requests and events). A reader is one of a
// user's clients: an OAuth client, such as the CLI or an MCP client, by its
// client id, whichever endpoint its token calls; a personal access token; or
// the web UI. events.read and events.acknowledge are internal commands that
// only the web UI's session runs, so their reader is the web UI's; agents read
// and acknowledge through whats_new and the wait, which share these cursors
// (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (50)). events.read returns the events after the reader's cursor, oldest
// first, and moves nothing, so the same events come back until they are
// acknowledged. events.acknowledge moves the reader's cursor up to an event
// that exists, and never back. Neither is a change to a request, so neither
// records an event.
//
// Readers get only domain events they may see (requests: Readers get only
// domain events they may see; activity-log: Security events are shown to
// admins only): a domain event is a change to a request, and every member sees
// every request, so a reader gets every domain event; a security event, such
// as a role change, reaches no reader, not even an admin's, and a cursor passes
// over it. Someone who is no longer a member gets 403 and nothing, from the
// membership re-check that runs before anything is read.

/** Which of a user's clients a caller reads as. */
export function readerOf(caller: Caller): string {
  switch (caller.kind) {
    case "oauth_token":
      return `oauth:${caller.clientId}`;
    case "personal_access_token":
      return `pat:${caller.tokenId}`;
    case "web_session":
      return "web";
    default:
      throw new Error("Only a caller that acts for a user reads events.");
  }
}

/** The reader's cursor: the number of the last event it acknowledged, 0 before the first. */
export async function cursorOf({ tx, orgId }: OrgContext, userId: string, reader: string): Promise<number> {
  const [row] = await tx
    .select({ acknowledged: readCursors.acknowledged })
    .from(readCursors)
    .where(and(eq(readCursors.orgId, orgId), eq(readCursors.userId, userId), eq(readCursors.reader, reader)));
  return row?.acknowledged ?? 0;
}

/** The number of the install's last event; 0 before the first. */
async function lastEventNumber({ tx, orgId }: OrgContext): Promise<number> {
  const [row] = await tx.select({ lastNumber: eventSequence.lastNumber }).from(eventSequence).where(eq(eventSequence.orgId, orgId));
  return row?.lastNumber ?? 0;
}

function readerContext(context: HandlerContext): { userId: string; reader: string } {
  return { userId: actingUserOf(context), reader: readerOf(context.caller) };
}

export const EVENT_READ_HANDLERS: Handlers = {
  [readEvents.id]: defineHandler(readEvents, async ({ limit }, context) => {
    const { userId, reader } = readerContext(context);
    const cursor = await cursorOf(context, userId, reader);
    const rows = await context.tx
      .select({ number: events.number, type: events.type, occurredAt: events.occurredAt, data: events.data })
      .from(events)
      .where(and(eq(events.orgId, context.orgId), eq(events.class, "domain"), gt(events.number, cursor)))
      .orderBy(asc(events.number))
      .limit(limit ?? 100);
    return {
      events: rows.map(({ number, type, occurredAt, data }) => ({
        number,
        type,
        occurredAt: occurredAt.toISOString(),
        data: data as Record<string, string | number | boolean>,
      })),
      cursor,
    };
  }),

  [acknowledgeEvents.id]: defineHandler(acknowledgeEvents, async ({ upTo }, context) => {
    const { userId, reader } = readerContext(context);
    return { cursor: await acknowledgeUpTo(context, userId, reader, upTo) };
  }),
};

/**
 * Moves the reader's cursor up to an event that exists, and never back;
 * returns the cursor. A number no event has yet is refused with 404 and moves
 * nothing.
 */
export async function acknowledgeUpTo(context: OrgContext, userId: string, reader: string, upTo: number): Promise<number> {
  if (upTo > (await lastEventNumber(context))) throw new Refusal("record-not-found", "There is no event with that number yet.");
  const [row] = await context.tx
    .insert(readCursors)
    .values({ orgId: context.orgId, userId, reader, acknowledged: upTo })
    .onConflictDoUpdate({
      target: [readCursors.orgId, readCursors.userId, readCursors.reader],
      set: { acknowledged: sql`greatest(${readCursors.acknowledged}, excluded.acknowledged)`, updatedAt: sql`now()` },
    })
    .returning({ acknowledged: readCursors.acknowledged });
  return row?.acknowledged ?? upTo;
}
