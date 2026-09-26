import { listActivityLog } from "@tiehall/catalog";
import { formatRequestKey, type EventActorKind, type EventClass, type OperatorCommand, type Surface } from "@tiehall/core";
import { events, requests, securityEventOrigins, teams, users } from "@tiehall/db";
import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { resolveRequestKey } from "./request-keys.ts";

// The admin view of the activity log (activity-log: The admin view;
// activity-log: The activity log holds domain events and security events;
// activity-log: IP addresses and user agents are kept apart for 90 days;
// activity-log: Security events are shown to admins only; design.md,
// Decisions this change rests on: D28 #4, #9, #48; design.md, Self-hosting
// decisions: S14). activity_log.list reads the events, newest first, with
// domain and security events alike, filtered by time, actor, request and
// event type, and pages by event number. Each event shows its number, time,
// class, type, the ids and values its type declares, and who caused it, with
// the user as every output names one and the current key of the request it
// names; a security event also shows its IP address and user
// agent while the side table still holds them. It is an admin action, so
// execute() refuses it to a member with 403 and no agent surface offers it;
// it reads and changes nothing.

export const ACTIVITY_LOG_HANDLERS: Handlers = {
  [listActivityLog.id]: defineHandler(listActivityLog, async (input, context) => {
    const { tx, orgId } = context;
    const conditions: SQL[] = [eq(events.orgId, orgId)];
    if (input.request !== undefined) {
      const { requestId } = await resolveRequestKey(context, input.request);
      conditions.push(sql`${events.data}->>'requestId' = ${requestId}`);
    }
    if (input.actorUserId !== undefined) conditions.push(eq(events.actorUserId, input.actorUserId));
    if (input.type !== undefined) conditions.push(eq(events.type, input.type));
    if (input.from !== undefined) conditions.push(gte(events.occurredAt, new Date(input.from)));
    if (input.to !== undefined) conditions.push(lte(events.occurredAt, new Date(input.to)));
    if (input.before !== undefined) conditions.push(lt(events.number, input.before));
    const rows = await tx
      .select({
        number: events.number,
        occurredAt: events.occurredAt,
        class: events.class,
        type: events.type,
        data: events.data,
        actorKind: events.actorKind,
        actorUserId: events.actorUserId,
        client: events.client,
        surface: events.surface,
        teamId: events.teamId,
        operatorCommand: events.operatorCommand,
        login: users.githubLogin,
        bot: users.bot,
        requestNumber: requests.number,
        requestTeamKey: teams.key,
        ipAddress: securityEventOrigins.ipAddress,
        userAgent: securityEventOrigins.userAgent,
      })
      .from(events)
      .leftJoin(users, and(eq(users.orgId, events.orgId), eq(users.id, events.actorUserId)))
      .leftJoin(requests, and(eq(requests.orgId, events.orgId), sql`${requests.id}::text = ${events.data}->>'requestId'`))
      .leftJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
      .leftJoin(securityEventOrigins, and(eq(securityEventOrigins.orgId, events.orgId), eq(securityEventOrigins.eventNumber, events.number)))
      .where(and(...conditions))
      .orderBy(desc(events.number))
      .limit(input.limit ?? 100);
    return {
      events: rows.map((row) => {
        const data = row.data as Record<string, string | number | boolean>;
        const requestId = data["requestId"];
        return {
          number: row.number,
          occurredAt: row.occurredAt.toISOString(),
          class: row.class as EventClass,
          type: row.type,
          data,
          actor: {
            kind: row.actorKind as EventActorKind,
            ...(row.actorUserId === null || row.login === null || row.bot === null
              ? {}
              : { user: { id: row.actorUserId, login: row.login, kind: "human" as const, bot: row.bot } }),
            ...(row.client === null ? {} : { client: row.client }),
            ...(row.surface === null ? {} : { surface: row.surface as Surface }),
            ...(row.teamId === null ? {} : { teamId: row.teamId }),
            ...(row.operatorCommand === null ? {} : { operatorCommand: row.operatorCommand as OperatorCommand }),
          },
          ...(typeof requestId === "string" && row.requestNumber !== null && row.requestTeamKey !== null
            ? { request: { id: requestId, key: formatRequestKey(row.requestTeamKey, row.requestNumber) } }
            : {}),
          ...(row.class === "security" && (row.ipAddress !== null || row.userAgent !== null)
            ? { origin: { ...(row.ipAddress === null ? {} : { ipAddress: row.ipAddress }), ...(row.userAgent === null ? {} : { userAgent: row.userAgent }) } }
            : {}),
        };
      }),
    };
  }),
};
