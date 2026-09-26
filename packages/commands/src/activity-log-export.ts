import { exportActivityLog, type exportedEvent } from "@tiehall/catalog";
import { activityLogExported, type EventActorKind, type EventClass, type OperatorCommand, type Surface } from "@tiehall/core";
import { events } from "@tiehall/db";
import { asc, count, eq, min } from "drizzle-orm";
import type { ConfirmDownloads } from "./confirm-route.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { OrgContext } from "./with-org.ts";
import type { z } from "zod";

// Exporting the activity log (activity-log: Exporting the activity log;
// activity-log: Which actions are security events; activity-log: IP addresses
// and user agents are kept apart for 90 days; agent-safety: Actions that need
// the confirmation step; design.md, Decisions this change rests on: D28 #4;
// design.md, Self-hosting decisions: S7 and S14). activity_log.export runs
// only in the web UI, for an admin, with the confirmation step from its
// review page at /confirm/activity_log.export: execute() refuses a call
// without a valid nonce with 403 before anything is read, so nothing is
// exported. It reads every event of the install, oldest first, as ids alone
// (no message or packet body, and no IP address or user agent, which live
// apart from the events), and records the export as a security event in the
// same transaction, naming the admin's web session and the number of the last
// event exported. The confirm page's POST answers with the JSONL file: one
// event per line.

type ExportedEvent = z.output<typeof exportedEvent>;

/** Every event of the install, oldest first, as the export carries it. */
async function exportedEvents({ tx, orgId }: OrgContext): Promise<ExportedEvent[]> {
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
    })
    .from(events)
    .where(eq(events.orgId, orgId))
    .orderBy(asc(events.number));
  return rows.map((row) => ({
    number: row.number,
    occurredAt: row.occurredAt.toISOString(),
    class: row.class as EventClass,
    type: row.type,
    data: row.data as Record<string, string | number | boolean>,
    actor: {
      kind: row.actorKind as EventActorKind,
      ...(row.actorUserId === null ? {} : { userId: row.actorUserId }),
      ...(row.client === null ? {} : { client: row.client }),
      ...(row.surface === null ? {} : { surface: row.surface as Surface }),
      ...(row.teamId === null ? {} : { teamId: row.teamId }),
      ...(row.operatorCommand === null ? {} : { operatorCommand: row.operatorCommand as OperatorCommand }),
    },
  }));
}

export const ACTIVITY_LOG_EXPORT_HANDLERS: Handlers = {
  [exportActivityLog.id]: defineHandler(exportActivityLog, async (_input, context) => {
    const exported = await exportedEvents(context);
    const lastNumber = exported.at(-1)?.number ?? 0;
    return context.write(async (writer) => {
      await writer.record(activityLogExported, { lastNumber });
      return { events: exported, lastNumber };
    });
  }),
};

/** The review page of the export, in Tiehall's own words. */
export const ACTIVITY_LOG_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [exportActivityLog.id]: async (_input, context) => {
    const [stats] = await context.tx.select({ total: count(), first: min(events.number) }).from(events).where(eq(events.orgId, context.orgId));
    const total = stats?.total ?? 0;
    return {
      title: "Export the activity log",
      lines: [
        {
          text:
            total === 0
              ? "Export the activity log as a JSONL file. It holds no events yet."
              : `Export the activity log as a JSONL file: ${total} events, one per line, from event ${stats?.first ?? 1} to the latest.`,
        },
        { text: "Each line carries the event's number, time, class, type, the ids of what it concerns and who caused it, and no message or packet body." },
        { text: "The file holds no IP address or user agent; the admin view shows them next to security events while they are kept." },
        { text: "The export is recorded in the activity log as a security event that names you." },
      ],
    };
  },
};

/** The export's confirmation answers with the JSONL file made from the command's output. */
export const ACTIVITY_LOG_DOWNLOADS: ConfirmDownloads = {
  [exportActivityLog.id]: (output) => {
    const { events: exported } = output as { events: ExportedEvent[] };
    return {
      filename: `tiehall-activity-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
      contentType: "application/jsonl; charset=utf-8",
      body: exported.map((event) => `${JSON.stringify(event)}\n`).join(""),
    };
  },
};
