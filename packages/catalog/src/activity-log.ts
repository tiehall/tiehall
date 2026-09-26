import { EVENT_ACTOR_KINDS, EVENT_CLASSES, EVENT_FIELD_NAME, EVENT_STRING_VALUE, EVENT_TYPE_NAME, OPERATOR_COMMANDS, SURFACES } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { requestKey, requestRef } from "./requests.ts";
import { user } from "./schemas.ts";

// The admin view of the activity log (activity-log: The admin view;
// activity-log: The activity log holds domain events and security events;
// activity-log: IP addresses and user agents are kept apart for 90 days;
// activity-log: Security events are shown to admins only; teams-and-roles:
// What admins and members may do). An admin views the log in the web UI,
// newest first, filtered by time, actor, request and event type. It is an
// admin action, so it runs only in the web UI and no agent surface offers it.

/** Who caused an event, as the event records it: the actor kind, and the user, client, surface, team or operator command it names. */
export const activityActor = z.object({
  kind: z.enum(EVENT_ACTOR_KINDS),
  /** The accountable human, with their GitHub login as the install last saw it and whether they are a bot. */
  user: user.optional(),
  /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
  client: z.string().optional(),
  surface: z.enum(SURFACES).optional(),
  teamId: z.uuid().optional(),
  operatorCommand: z.enum(OPERATOR_COMMANDS).optional(),
});

/** The IP address and user agent recorded with a security event, while they are kept. */
export const activityOrigin = z.object({ ipAddress: z.string().optional(), userAgent: z.string().optional() });

/** An event as the admin view shows it. */
export const activityEvent = z.object({
  number: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  class: z.enum(EVENT_CLASSES),
  type: z.string().regex(EVENT_TYPE_NAME),
  /** The ids and fixed values the event's type declares, never a body. */
  data: z.record(z.string().regex(EVENT_FIELD_NAME), z.union([z.string().regex(EVENT_STRING_VALUE), z.number(), z.boolean()])),
  actor: activityActor,
  /** The request the event concerns, by its current key, for an event that names one. */
  request: requestRef.optional(),
  /** Only for a security event, and only while they are kept: 90 days. */
  origin: activityOrigin.optional(),
});

/** An instant, as an ISO 8601 date-time with an offset or Z. */
const instant = z.iso.datetime({ offset: true });

export const listActivityLog = defineCommand({
  id: "activity_log.list",
  summary:
    "List the activity log's events, newest first: domain events and security events, filtered by time, actor, request and event type, with a security event's IP address and user agent while they are kept.",
  input: z.object({
    from: instant.optional().meta({ description: "Only events at or after this time." }),
    to: instant.optional().meta({ description: "Only events at or before this time." }),
    actorUserId: z.uuid().optional().meta({ description: "Only events this user caused, through a web session or an agent." }),
    request: requestKey.optional(),
    type: z.string().regex(EVENT_TYPE_NAME).optional().meta({ description: "Only events of this type, such as member.role_changed." }),
    before: z.number().int().min(1).optional().meta({ description: "Only events numbered below this, for the next page." }),
    limit: z.number().int().min(1).max(500).optional().meta({ description: "How many events to return, 1 to 500; 100 unless given." }),
  }),
  output: z.object({ events: z.array(activityEvent) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "activity_log",
  surfaces: [],
  stability: "beta",
});

// Exporting the activity log (activity-log: Exporting the activity log;
// agent-safety: Actions that need the confirmation step). An admin exports
// the whole log as JSONL from the web UI, with the confirmation step, so no
// agent surface offers it. Each line is an event with its number, time, class,
// type, the ids it concerns and who caused it, by ids alone: no body, and no
// IP address or user agent. The export is itself a security event.

/** Who caused an exported event, by ids: the actor kind, and the user, client, surface, team or operator command it names. */
export const exportedActor = activityActor.omit({ user: true }).extend({ userId: z.uuid().optional() });

/** An event as a line of the export carries it. */
export const exportedEvent = activityEvent.omit({ request: true, origin: true, actor: true }).extend({ actor: exportedActor });

export const exportActivityLog = defineCommand({
  id: "activity_log.export",
  summary: "Export the whole activity log as JSONL, one event per line, with the ids each event concerns and who caused it, and no body, IP address or user agent.",
  input: z.object({}),
  output: z.object({
    events: z.array(exportedEvent),
    /** The number of the last event the export holds; 0 for an empty log. */
    lastNumber: z.number().int().min(0),
  }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "activity_log",
  surfaces: [],
  stability: "beta",
});

export const ACTIVITY_LOG_COMMANDS = [listActivityLog, exportActivityLog];
