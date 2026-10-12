import { acknowledgeEvents, readEvents } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { events, eventSequence, readCursors } from "@tiehall/db";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Caller } from "./caller.ts";
import { CLI_CLIENT_ID } from "./device-flow.ts";
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
// A reader that has no cursor yet, such as a new MCP client of the user or
// the CLI's first login, starts at the user's web inbox cursor, not at the
// first event, so that it does not replay what the user has seen there
// (requests: Read cursors move only on acknowledgement;
// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55
// (44); design.md, Technical decisions: T6): its cursor is created at that
// value when it first reads, and keeps its place from then on, wherever the
// web inbox goes, and an acknowledgement that creates it creates it no lower.
// The web inbox itself starts at the first event. The Claude Code hooks read
// after the furthest cursor of the user's agent clients instead of their own,
// so that what the agent acknowledged through whats_new is not announced
// again; the CLI's own place, when it has none yet, is the web inbox's, as
// above.
//
// Readers get only domain events they may see (requests: Readers get only
// domain events they may see; activity-log: Security events are shown to
// admins only): every member sees every request, so a reader gets every
// domain event on a request; a security event, such as a role change, reaches
// no reader, not even an admin's, and neither does a change to the consumer
// map, which concerns no request (decisions-from-groups-15-28, D55 (60)); a
// cursor passes over both. Someone who is no longer a member gets 403 and nothing, from the
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

/** The web inbox's reader, whose cursor every other reader of the user starts at. */
const WEB_READER = "web";

/** The CLI's reader, which the hooks read as. */
const CLI_READER = `oauth:${CLI_CLIENT_ID}`;

/** The reader's stored cursor, if it has one. */
async function storedCursorOf({ tx, orgId }: OrgContext, userId: string, reader: string): Promise<number | undefined> {
  const [row] = await tx
    .select({ acknowledged: readCursors.acknowledged })
    .from(readCursors)
    .where(and(eq(readCursors.orgId, orgId), eq(readCursors.userId, userId), eq(readCursors.reader, reader)));
  return row?.acknowledged;
}

/**
 * The reader's cursor: the number of the last event it acknowledged; for a
 * reader with no cursor yet, where it starts, the web inbox's cursor, or 0 for
 * the web inbox itself. Reading it creates nothing, so it reads in a read-only
 * transaction too, as the wait does.
 */
export async function cursorOf(context: OrgContext, userId: string, reader: string): Promise<number> {
  const stored = await storedCursorOf(context, userId, reader);
  if (stored !== undefined) return stored;
  return reader === WEB_READER ? 0 : ((await storedCursorOf(context, userId, WEB_READER)) ?? 0);
}

/**
 * The reader's cursor, created where cursorOf() says it starts when the reader
 * has none yet, so that it keeps that place: reading without acknowledging
 * returns the same updates again, wherever the web inbox goes meanwhile.
 */
export async function openCursor(context: OrgContext, userId: string, reader: string): Promise<number> {
  const stored = await storedCursorOf(context, userId, reader);
  if (stored !== undefined || reader === WEB_READER) return stored ?? 0;
  const start = await cursorOf(context, userId, reader);
  await context.tx.insert(readCursors).values({ orgId: context.orgId, userId, reader, acknowledged: start }).onConflictDoNothing();
  return (await storedCursorOf(context, userId, reader)) ?? start;
}

/**
 * The furthest cursor of the user's agent clients, the CLI's and every other
 * reader's but the web inbox's, which the hooks read after; the CLI's counts
 * from where it starts when it has no cursor yet.
 */
export async function furthestAgentCursorOf(context: OrgContext, userId: string): Promise<number> {
  const rows = await context.tx
    .select({ reader: readCursors.reader, acknowledged: readCursors.acknowledged })
    .from(readCursors)
    .where(and(eq(readCursors.orgId, context.orgId), eq(readCursors.userId, userId)));
  const agents = rows.filter(({ reader }) => reader !== WEB_READER).map(({ acknowledged }) => acknowledged);
  const cli = rows.some(({ reader }) => reader === CLI_READER) ? [] : [await cursorOf(context, userId, CLI_READER)];
  return Math.max(0, ...agents, ...cli);
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
      .where(and(eq(events.orgId, context.orgId), eq(events.class, "domain"), isNotNull(sql`${events.data} ->> 'requestId'`), gt(events.number, cursor)))
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
 * returns the cursor. A reader with no cursor yet has it created no lower than
 * where it starts. A number no event has yet is refused with 404 and moves
 * nothing.
 */
export async function acknowledgeUpTo(context: OrgContext, userId: string, reader: string, upTo: number): Promise<number> {
  if (upTo > (await lastEventNumber(context))) throw new Refusal("record-not-found", "There is no event with that number yet.");
  const start = await cursorOf(context, userId, reader);
  const [row] = await context.tx
    .insert(readCursors)
    .values({ orgId: context.orgId, userId, reader, acknowledged: Math.max(upTo, start) })
    .onConflictDoUpdate({
      target: [readCursors.orgId, readCursors.userId, readCursors.reader],
      set: { acknowledged: sql`greatest(${readCursors.acknowledged}, ${upTo})`, updatedAt: sql`now()` },
    })
    .returning({ acknowledged: readCursors.acknowledged });
  return row?.acknowledged ?? upTo;
}
