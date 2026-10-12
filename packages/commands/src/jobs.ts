import type { Transaction } from "@tiehall/db";

// Jobs a write starts, and the kinds of job (design.md, Technical decisions: T5
// and T6; self-host-install: Migrations expand, then contract). A job is sent
// inside the transaction of the write that starts it, so it commits with the
// change and its event, or not at all: a job never runs for a change that did
// not commit. Each kind of job has its own queue, whose name carries the
// version of the job's data shape: a release that changes the shape bumps the
// version, so its jobs go to a new queue, which a worker of the previous
// release does not work. Each queue has a dead-letter queue, where a job goes
// once its attempts are used up.

/** Job data holds ids and settings, never message text or credentials, like events and logs. */
export type JobData = Readonly<Record<string, unknown>>;

/** A kind of job, by the queue its jobs go to. The data type is for the compiler only. */
export interface JobType<D extends JobData> {
  /** The queue's name, which carries the version of the data's shape. */
  queue: string;
  /** Never set: it only carries the data type. */
  readonly data?: D;
}

/** When a job runs, for one that waits, and which jobs it runs one at a time with. */
export interface JobOptions {
  /** The job runs no earlier than this, such as the end of a burst of contract reports. */
  startAfter?: Date;
  /**
   * For a job type whose jobs run one key at a time (JobSettings.policy
   * key_strict_fifo), the key it runs under, such as a request's id: jobs with
   * the same key run one after the other, never two at once, in the order of
   * the transactions that sent them, and jobs with other keys run beside them.
   * Every job of such a type has one.
   */
  singletonKey?: string;
}

export interface JobSender {
  /** Sends a job inside the caller's transaction. */
  send(tx: Transaction, queue: string, data: JobData, options?: JobOptions): Promise<void>;
  /**
   * Runs again, inside the caller's transaction, the job of a queue that runs
   * one key at a time (JobSettings.policy key_strict_fifo) whose attempts
   * were used up, so it moved to the dead-letter queue, such as a request's
   * mirror job: the job gets one more attempt, at once, and the later jobs of
   * its key, which it held back, run after it. Returns false when the key has
   * no such job, as when it is being tried again already. A sender without a
   * queue behind it, such as a test's, has none.
   */
  retryFailed?(tx: Transaction, queue: string, key: string): Promise<boolean>;
  /**
   * Takes out, inside the caller's transaction, the job of a queue that runs
   * one key at a time whose attempts were used up, which holds back the later
   * jobs of its key, such as a request's mirror job in the dead-letter queue,
   * so a newer job of the key runs instead (decisions-from-groups-15-28:
   * design.md, Technical decisions: T10). Returns when that job failed, or
   * undefined when the key has none. A sender without a queue behind it, such
   * as a test's, has none.
   */
  dropFailed?(tx: Transaction, queue: string, key: string): Promise<Date | undefined>;
  /** Whether a queue that runs one key at a time holds a job of this key whose attempts were used up. */
  holdsFailed?(queue: string, key: string): Promise<boolean>;
}

/** How the queue retries a kind of job. */
export interface JobSettings {
  /** How many times a failed job runs again before it moves to the dead-letter queue. */
  retryLimit: number;
  /** How long to wait before running a failed job again, in seconds. */
  retryDelaySeconds: number;
  /** Whether that wait doubles from one attempt to the next. */
  retryBackoff: boolean;
  /** How long one attempt may run before it counts as failed, in seconds. */
  expireInSeconds: number;
  /**
   * key_strict_fifo runs the queue's jobs one key at a time, such as each
   * mirror's jobs (design.md, Technical decisions: T6): a job that is active,
   * waiting to be retried or failed holds back the later jobs with its key,
   * and no other key. Each job is then sent with a key (JobOptions). A queue's
   * policy is set when the queue is created and never changes, so a type that
   * changes it gets a new version, and with it a new queue.
   */
  policy?: "key_strict_fifo";
}

export interface DefinedJobType<D extends JobData> extends JobType<D> {
  /** The kind of job, a dotted lower-case name such as mirror.create_issue. */
  name: string;
  /** The version of its data's shape. */
  version: number;
  deadLetterQueue: string;
  settings: JobSettings;
}

/** A job type that breaks the naming or settings rules; its message says how. */
export class JobTypeError extends Error {
  override name = "JobTypeError";
}

const JOB_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function defineJobType<D extends JobData>(name: string, version: number, settings: JobSettings): DefinedJobType<D> {
  if (!JOB_NAME.test(name)) {
    throw new JobTypeError(`The job type "${name}" is not a dotted lower-case name, such as "mirror.create_issue".`);
  }
  if (/\.v\d+$/.test(name)) {
    throw new JobTypeError(`The job type "${name}" carries a version in its name; give the version apart, as a number.`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new JobTypeError(`The version of ${name} must be a whole number from 1, not ${version}.`);
  }
  const whole = (setting: keyof JobSettings, from: number) => {
    const value = settings[setting];
    if (!Number.isSafeInteger(value) || (value as number) < from) {
      throw new JobTypeError(`${name}: ${setting} must be a whole number from ${from}, not ${String(value)}.`);
    }
  };
  whole("retryLimit", 0);
  whole("retryDelaySeconds", 0);
  whole("expireInSeconds", 1);
  if (settings.policy !== undefined && settings.policy !== "key_strict_fifo") {
    throw new JobTypeError(`${name}: the policy ${String(settings.policy)} is not one a job type may have; key_strict_fifo is.`);
  }
  const queue = `${name}.v${version}`;
  return { name, version, queue, deadLetterQueue: `${queue}.dead_letter`, settings: { ...settings } };
}
