import type { EventData, EventType, Provenance } from "@tiehall/core";
import { securityEventOrigins, type Database } from "@tiehall/db";
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
// token, session or job, never a value the handler or the payload chose. For a
// security event, the caller's IP address and user agent go into a side table
// in the same transaction, never into the event (activity-log: IP addresses and
// user agents are kept apart for 90 days).

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

/** Where a caller's request came from, as the web layer saw it. */
export interface Origin {
  ipAddress?: string;
  userAgent?: string;
}

export interface WriteOptions {
  /** Kept for the write's security events, apart from them, for 90 days. */
  origin?: Origin;
}

/** A longer user agent is cut to this length; it is shown to admins, not parsed. */
export const USER_AGENT_MAX_LENGTH = 512;

/** A write that recorded no event: it is rolled back, because every committed change leaves its event. */
export class WriteWithoutEventError extends Error {
  override name = "WriteWithoutEventError";
  constructor() {
    super("A write must record the event of its change; this one recorded none, so nothing of it was committed.");
  }
}

export async function write<R>(
  store: Store,
  provenance: Provenance,
  change: (writer: Writer) => Promise<R>,
  options: WriteOptions = {},
): Promise<R> {
  return withOrg(store.database, (context) => writeIn(context, store.jobs, provenance, change, options));
}

/**
 * The same write inside a transaction withOrg() already opened, such as the
 * one execute() runs a handler in: the change, its events and its jobs join
 * that transaction and commit or roll back with it.
 */
export async function writeIn<R>(
  context: OrgContext,
  jobs: JobSender,
  provenance: Provenance,
  change: (writer: Writer) => Promise<R>,
  options: WriteOptions = {},
): Promise<R> {
  const ipAddress = options.origin?.ipAddress;
  const userAgent = options.origin?.userAgent?.slice(0, USER_AGENT_MAX_LENGTH);
  let recorded = 0;
  const writer: Writer = {
    ...context,
    async record(type, data) {
      const event = await appendEvent(context, type, data, provenance);
      recorded++;
      if (type.class === "security" && (ipAddress !== undefined || userAgent !== undefined)) {
        await context.tx.insert(securityEventOrigins).values({
          orgId: context.orgId,
          eventNumber: event.number,
          ipAddress: ipAddress ?? null,
          userAgent: userAgent ?? null,
        });
      }
      return event;
    },
    async enqueue(type, data) {
      await jobs.send(context.tx, type.queue, data);
    },
  };
  const result = await change(writer);
  if (recorded === 0) throw new WriteWithoutEventError();
  return result;
}
