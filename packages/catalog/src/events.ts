import { EVENT_FIELD_NAME, EVENT_STRING_VALUE, EVENT_TYPE_NAME } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";

// Reading the event log (requests: Read cursors move only on acknowledgement;
// requests: Events carry ids, not bodies; design.md, Design rules: Requests
// and events). A reader, one client of a user, reads the events after its own
// cursor and acknowledges them, which alone moves the cursor. An event names
// what changed by ids and fixed values, never by a body, so a reader fetches
// content through the reads. Readers get only domain events, the changes to
// requests, which every member may see; security events reach no reader
// (requests: Readers get only domain events they may see). The requester
// loop's readers, whats_new and the wait, build on these (group 19).
//
// Both are internal commands that no agent surface offers, and only the web
// UI's session runs them (requester-loop: The pull readers;
// decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (50)): they return every domain event of the install, outside the scope
// of whats_new, and share each client's cursor with it, so reading through one
// would move the other's place. whats_new, `tiehall updates` and the wait are
// the readers' API.

/** An event as a reader gets it: its number, its type, when it happened, and the ids and values its type declares. */
export const eventView = z.object({
  number: z.number().int().min(1),
  type: z.string().regex(EVENT_TYPE_NAME),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string().regex(EVENT_FIELD_NAME), z.union([z.string().regex(EVENT_STRING_VALUE), z.number(), z.boolean()])),
});

/** A reader's cursor: the number of the last event it acknowledged, 0 before the first. */
const cursor = z.number().int().min(0).meta({ description: "The number of the last event this reader acknowledged; 0 before the first." });

export const readEvents = defineCommand({
  id: "events.read",
  summary:
    "Read the events about requests after your cursor, oldest first. Reading moves nothing: the same events come back until you acknowledge them. Each of your clients has its own cursor. Offered on no agent surface.",
  input: z.object({
    limit: z.coerce.number().int().min(1).max(500).optional().meta({ description: "How many events to return, 1 to 500; 100 unless given." }),
  }),
  output: z.object({ events: z.array(eventView), cursor }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const acknowledgeEvents = defineCommand({
  id: "events.acknowledge",
  summary: "Acknowledge the events up to a number, so that your next read starts after it. A cursor never moves back. Offered on no agent surface.",
  input: z.object({
    upTo: z.number().int().min(0).meta({ description: "The number of the last event you have handled." }),
  }),
  output: z.object({ cursor }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const EVENT_COMMANDS = [readEvents, acknowledgeEvents];
