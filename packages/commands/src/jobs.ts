import type { Transaction } from "@tiehall/db";

// Jobs a write starts (design.md, Technical decisions: T5 and T6). A job is
// sent inside the transaction of the write that starts it, so it commits with
// the change and its event, or not at all: a job never runs for a change that
// did not commit. Task 4.11 sends them through pg-boss's queues in Postgres.

/** Job data holds ids and settings, never message text or credentials, like events and logs. */
export type JobData = Readonly<Record<string, unknown>>;

/** A kind of job, by the queue its jobs go to. The data type is for the compiler only. */
export interface JobType<D extends JobData> {
  /** The queue's name, which carries the version of the data's shape. */
  queue: string;
  /** Never set: it only carries the data type. */
  readonly data?: D;
}

export interface JobSender {
  /** Sends a job inside the caller's transaction. */
  send(tx: Transaction, queue: string, data: JobData): Promise<void>;
}
