import { sql } from "drizzle-orm";
import type pg from "pg";
import { fromDrizzle, getConstructionPlans, getMigrationPlans, PgBoss } from "pg-boss";
import pgBoss from "pg-boss/package.json" with { type: "json" };
import { JOB_QUEUE_SCHEMA, MigrationError, withPassword, type DatabaseConnection } from "@tiehall/db";
import type { DefinedJobType, JobData, JobSender, JobSettings } from "./jobs.ts";
import type { Logger } from "./log.ts";

// The job queue (design.md, Technical decisions: T5 and T6): pg-boss, with its
// queues in Postgres, so an install runs no other service and a job commits
// with the write that starts it.
//
// Its schema is pg-boss's own, and the migrate step installs it as the database
// owner, from pg-boss's plans, before it sets up the app role. The app runs
// pg-boss as the app role, which uses the tables and owns none of them, so the
// app never migrates the queue's schema or rebuilds its indexes itself. Every
// process that opens the queue makes sure the queues of the job types it knows
// exist, each with its dead-letter queue and its current retry settings.

/** The version of the job queue's schema that this release's pg-boss needs. */
export const JOB_QUEUE_VERSION: number = pgBoss.pgboss.schema;

/**
 * Installs the job queue's schema, or upgrades it to this release's version,
 * on the owner's connection. It refuses a schema from a later release, whose
 * pg-boss this release's could not run on.
 */
export async function installJobQueue(owner: Pick<pg.ClientBase, "query">, log: (line: string) => void): Promise<void> {
  const { rows } = await owner.query<{ table: string | null }>("SELECT to_regclass($1)::text AS table", [
    `${JOB_QUEUE_SCHEMA}.version`,
  ]);
  if (rows[0]?.table === null || rows[0]?.table === undefined) {
    await owner.query(getConstructionPlans(JOB_QUEUE_SCHEMA));
    log(`migrate: installed the job queue's schema, version ${JOB_QUEUE_VERSION}`);
    return;
  }
  const version = await owner.query<{ version: string | number }>(`SELECT version FROM ${JOB_QUEUE_SCHEMA}.version`);
  const installed = Number(version.rows[0]?.version);
  if (installed === JOB_QUEUE_VERSION) return;
  if (!(installed < JOB_QUEUE_VERSION)) {
    throw new MigrationError(
      `The job queue's schema is at version ${installed}, which a later release installed; this image's job ` +
        `queue needs version ${JOB_QUEUE_VERSION}, so this image is older than the database's schema. To go back ` +
        "to it, restore the backup taken before the upgrade.",
    );
  }
  const { transactional, concurrent } = splitMigrationPlan(getMigrationPlans(JOB_QUEUE_SCHEMA, installed));
  await owner.query(transactional);
  // Index builds that pg-boss would otherwise leave to a background task of an instance that may migrate,
  // which the app's never is: each one runs on its own, outside a transaction, as CONCURRENTLY needs.
  for (const statement of concurrent) await owner.query(statement);
  log(`migrate: upgraded the job queue's schema from version ${installed} to ${JOB_QUEUE_VERSION}`);
}

/**
 * pg-boss's migration plan is one transaction, then the CONCURRENTLY index
 * builds, each a statement of its own after the transaction's COMMIT.
 */
export function splitMigrationPlan(plan: string): { transactional: string; concurrent: string[] } {
  const commit = plan.lastIndexOf("COMMIT;");
  if (commit === -1) return { transactional: plan, concurrent: [] };
  const end = commit + "COMMIT;".length;
  const concurrent = plan
    .slice(end)
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("--")));
  return { transactional: plan.slice(0, end), concurrent };
}

export interface JobQueueOptions {
  /** The app's connection, as the app role. */
  connection: DatabaseConnection;
  /** The job types this process sends or works; their queues are made sure to exist. */
  jobTypes: readonly DefinedJobType<JobData>[];
  /** The worker supervises the queues and runs the schedules; a process that only sends does neither. */
  supervise?: boolean;
  applicationName?: string;
  logger: Logger;
}

export interface JobQueue extends JobSender {
  /** The pg-boss instance, for the worker in this package. */
  readonly boss: PgBoss;
  retryFailed(tx: Parameters<JobSender["send"]>[0], queue: string, key: string): Promise<boolean>;
  dropFailed(tx: Parameters<JobSender["send"]>[0], queue: string, key: string): Promise<Date | undefined>;
  holdsFailed(queue: string, key: string): Promise<boolean>;
  /**
   * Stops taking jobs, gives the active ones up to the timeout to finish, then
   * releases the rest, which run again once a worker starts, and closes the
   * connection.
   */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export async function openJobQueue(options: JobQueueOptions): Promise<JobQueue> {
  const queues = options.jobTypes.map(({ queue }) => queue);
  const repeated = queues.filter((queue, index) => queues.indexOf(queue) !== index);
  if (repeated.length > 0) throw new Error(`Two job types use the queue ${repeated[0]}.`);
  const supervise = options.supervise ?? false;
  const boss = new PgBoss({
    connectionString: withPassword(options.connection),
    schema: JOB_QUEUE_SCHEMA,
    application_name: options.applicationName ?? "tiehall",
    max: 4,
    // The migrate step installs and upgrades the schema; the app role could not.
    migrate: false,
    createSchema: false,
    supervise,
    schedule: supervise,
    // Rebuilding an index needs its owner, which the app role never is.
    reindex: false,
  });
  // An EventEmitter without an error listener throws; pg-boss reports its own failures this way. The error is
  // logged by its name, code and stack; its message and pg-boss's warning data can quote a job's data.
  boss.on("error", (error: unknown) => options.logger.error("job queue: error", { error }));
  boss.on("warning", (warning: { message?: unknown }) =>
    options.logger.warn("job queue: warning", { warning: typeof warning.message === "string" ? warning.message : "unknown" }),
  );
  await boss.start();
  try {
    for (const type of options.jobTypes) await ensureQueue(boss, type);
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
  return {
    boss,
    async send(tx, queue, data, options = {}) {
      await boss.send(queue, data, {
        db: fromDrizzle(tx, sql),
        ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
        ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      });
    },
    async retryFailed(tx, queue, key) {
      const db = fromDrizzle(tx, sql);
      // A queue that runs one key at a time holds at most one failed job per key, which holds back the key's later jobs.
      const failed = (await boss.findJobs(queue, { key, db })).filter(({ state }) => state === "failed");
      if (failed.length === 0) return false;
      await boss.retry(
        queue,
        failed.map(({ id }) => id),
        { db },
      );
      return true;
    },
    async dropFailed(tx, queue, key) {
      const db = fromDrizzle(tx, sql);
      const failed = (await boss.findJobs(queue, { key, db })).filter(({ state }) => state === "failed");
      if (failed.length === 0) return undefined;
      await boss.deleteJob(
        queue,
        failed.map(({ id }) => id),
        { db },
      );
      // Read through the transaction, the time comes as Postgres wrote it.
      const at = failed[0]?.completedOn;
      return at === null || at === undefined ? new Date() : new Date(at);
    },
    async holdsFailed(queue, key) {
      return (await boss.findJobs(queue, { key })).some(({ state }) => state === "failed");
    },
    async stop({ timeoutMs = 10_000 } = {}) {
      await boss.stop({ graceful: true, timeout: timeoutMs, close: true });
    },
  };
}

/**
 * A job sender that opens its queue when it first sends a job, runs a failed
 * one again or takes one out, as the web role's does, and opens it again on
 * the next call when opening it failed. It passes each job's options on, such as the
 * key a job runs under, which a queue that runs one key at a time refuses a
 * job without, and when a job may start.
 */
export function lazyJobSender(open: () => Promise<JobQueue>): JobSender {
  let queue: Promise<JobQueue> | undefined;
  const opened = () =>
    (queue ??= open().catch((error: unknown) => {
      queue = undefined;
      throw error;
    }));
  return {
    async send(tx, name, data, options) {
      await (await opened()).send(tx, name, data, options);
    },
    async retryFailed(tx, name, key) {
      return (await opened()).retryFailed(tx, name, key);
    },
    async dropFailed(tx, name, key) {
      return (await opened()).dropFailed(tx, name, key);
    },
    async holdsFailed(name, key) {
      return (await opened()).holdsFailed(name, key);
    },
  };
}

/**
 * Creates a job type's dead-letter queue and queue when they are missing, and
 * applies its settings. The queue's policy, such as key_strict_fifo, is given
 * only when it is created, since pg-boss never changes a queue's policy.
 */
async function ensureQueue(boss: PgBoss, type: DefinedJobType<JobData>): Promise<void> {
  await boss.createQueue(type.deadLetterQueue);
  const settings = { deadLetter: type.deadLetterQueue, ...queueSettings(type.settings) };
  await boss.createQueue(type.queue, { ...settings, ...(type.settings.policy === undefined ? {} : { policy: type.settings.policy }) });
  await boss.updateQueue(type.queue, settings);
}

function queueSettings(settings: JobSettings) {
  return {
    retryLimit: settings.retryLimit,
    retryDelay: settings.retryDelaySeconds,
    retryBackoff: settings.retryBackoff,
    expireInSeconds: settings.expireInSeconds,
  };
}
