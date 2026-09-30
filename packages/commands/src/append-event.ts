import { checkProvenance, eventData, EventShapeError, type EventData, type EventType, type Provenance } from "@tiehall/core";
import { events } from "@tiehall/db";
import { sql } from "drizzle-orm";
import { EVENTS_CHANNEL } from "./event-wakeups.ts";
import { takeEventNumber } from "./event-sequence.ts";
import type { OrgContext } from "./with-org.ts";

// Appends one event inside the handler's transaction (requests: The event log;
// requests: Events carry ids, not bodies; activity-log: The activity log holds
// domain events and security events). The event takes the org's next number,
// holds only the fields its type declares, and records who caused it as the
// server stamped it. It commits or rolls back with the change it records.
// A domain event also sends a notification, which Postgres delivers when the
// transaction commits and drops when it rolls back, and whose payload is the
// event's number alone: it wakes the long-poll waits, which then read what
// came (event-wakeups.ts). A security event sends none, so it wakes no wait.

export interface AppendedEvent {
  /** The event's number in the install's sequence. */
  number: number;
}

export async function appendEvent<T extends EventType>(
  context: OrgContext,
  type: T,
  data: EventData<T>,
  provenance: Provenance,
): Promise<AppendedEvent> {
  // Both checks run before the number is taken, and a refusal throws, which rolls the whole transaction back.
  const checked = eventData(type, data);
  const problems = checkProvenance(provenance);
  if (problems.length > 0) throw new EventShapeError(problems.join("\n"));
  const number = await takeEventNumber(context);
  await context.tx.insert(events).values({
    orgId: context.orgId,
    number,
    class: type.class,
    type: type.type,
    data: checked,
    ...(provenance.actorKind === "operator"
      ? { actorKind: "operator", operatorCommand: provenance.command }
      : {
          actorKind: provenance.actorKind,
          actorUserId: provenance.userId ?? null,
          client: provenance.client ?? null,
          surface: provenance.surface ?? null,
          teamId: provenance.teamId ?? null,
        }),
  });
  if (type.class === "domain") await context.tx.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${String(number)})`);
  return { number };
}
