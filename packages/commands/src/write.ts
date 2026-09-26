import type { EventData, EventType, Provenance } from "@tiehall/core";
import type { Database } from "@tiehall/db";
import { appendEvent, type AppendedEvent } from "./append-event.ts";
import type { JobData, JobSender, JobType } from "./jobs.ts";
import { withOrg, type OrgContext } from "./with-org.ts";

// The single write path (requests: The event log; activity-log: Which actions
// are security events; design.md, Technical decisions: T5). Every command that
// changes something runs its change through write(): the change, the domain or
// security event that records it and any job it starts share one transaction
// for the install's org, so all of them commit or none does. The event log is
// then also the outbox: no separate table and no relay. Every event of a write
// carries the caller's provenance, which the server stamped from the caller's
// token, session or job, never a value the handler or the payload chose.

/** Where writes go: the app's database and the queue that jobs are sent to. */
export interface Store {
  database: Database;
  jobs: JobSender;
}

export interface Writer extends OrgContext {
  /** Records an event of this write, with the caller's provenance. */
  record<T extends EventType>(type: T, data: EventData<T>): Promise<AppendedEvent>;
  /** Starts a job that commits with this write. */
  enqueue<D extends JobData>(type: JobType<D>, data: D): Promise<void>;
}

/** A write that recorded no event: it is rolled back, because every committed change leaves its event. */
export class WriteWithoutEventError extends Error {
  override name = "WriteWithoutEventError";
  constructor() {
    super("A write must record the event of its change; this one recorded none, so nothing of it was committed.");
  }
}

export async function write<R>(store: Store, provenance: Provenance, change: (writer: Writer) => Promise<R>): Promise<R> {
  return withOrg(store.database, async (context) => {
    let recorded = 0;
    const writer: Writer = {
      ...context,
      async record(type, data) {
        const event = await appendEvent(context, type, data, provenance);
        recorded++;
        return event;
      },
      async enqueue(type, data) {
        await store.jobs.send(context.tx, type.queue, data);
      },
    };
    const result = await change(writer);
    if (recorded === 0) throw new WriteWithoutEventError();
    return result;
  });
}
