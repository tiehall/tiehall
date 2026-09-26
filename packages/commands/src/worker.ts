import { openDatabase, type Database, type DatabaseConnection } from "@tiehall/db";
import { openJobQueue } from "./job-queue.ts";
import type { DefinedJobType, JobData } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";

// The worker role (design.md, Technical decisions: T6; self-host-install: A
// restart stops the app gracefully). It works the queues of the job types it
// knows, as the app role, and supervises the queues. On stop, which SIGTERM
// triggers, it takes no new job and gives its active jobs up to the stop
// timeout to finish; the job queue releases the ones still running, so they
// run again once a worker starts after the restart, and no job is lost. A
// released job counts as one of its attempts. Its log lines are JSON and name
// jobs and the records they concern by id only: a job that fails is logged by
// its queue, its id, the ids in its data and its error's name, code and stack,
// never by its data or its error's message (self-host-install: Logs carry ids,
// never message text or credentials).

/** A job as its handler receives it. */
export interface RunningJob<D extends JobData> {
  id: string;
  queue: string;
  data: D;
  /** Aborted when the worker gives the job up, such as when it stops before the job finished. */
  signal: AbortSignal;
}

/** What a job's handler works with. */
export interface WorkerServices {
  /** The app's database, as the app role; handlers reach it through withOrg() or write(). */
  database: Database;
  /** The worker's clock. */
  now(): Date;
}

export interface WorkerJob<D extends JobData> {
  type: DefinedJobType<D>;
  /** Runs one job; a throw fails the attempt, which the queue retries until the retry limit. */
  handle(job: RunningJob<D>, services: WorkerServices): Promise<void>;
  /** How many jobs of this type the worker runs at once. */
  concurrency?: number;
  /** A cron expression, in UTC, on which the worker schedules a job of this type with no data. */
  schedule?: string;
}

export interface WorkerOptions {
  /** The app's connection, as the app role. */
  connection: DatabaseConnection;
  jobs: readonly WorkerJob<JobData>[];
  /** How long active jobs may take to finish once the worker stops; the rest are released. */
  stopTimeoutMs?: number;
  /** How often each queue is polled for new jobs. */
  pollingIntervalSeconds?: number;
  /** The clock handlers read; the system clock unless a test controls it. */
  clock?: () => Date;
  logger?: Logger;
}

export interface Worker {
  /** Stops taking jobs, lets active ones finish within the stop timeout, releases the rest, and disconnects. */
  stop(): Promise<void>;
}

/** Well within the 30 seconds Compose waits after SIGTERM before it kills the container. */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const logger = options.logger ?? createLogger();
  const queue = await openJobQueue({
    connection: options.connection,
    jobTypes: options.jobs.map(({ type }) => type),
    supervise: true,
    applicationName: "tiehall worker",
    logger,
  });
  const services: WorkerServices = {
    database: openDatabase(options.connection, { applicationName: "tiehall worker" }),
    now: options.clock ?? (() => new Date()),
  };
  let stopping = false;
  /** Jobs whose handler is running, by id, with their queue. */
  const active = new Map<string, string>();
  /** Jobs the stop gave up on while their handler ran. */
  const released = new Map<string, string>();
  try {
    for (const job of options.jobs) {
      const name = job.type.queue;
      await queue.boss.work<JobData>(
        name,
        {
          batchSize: 1,
          localConcurrency: job.concurrency ?? 1,
          ...(options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
        },
        async ([running]) => {
          if (running === undefined) return;
          active.set(running.id, name);
          try {
            await job.handle({ id: running.id, queue: name, data: running.data, signal: running.signal }, services);
          } catch (error) {
            logger.error("worker: job failed", { queue: name, jobId: running.id, ids: idsOf(running.data), error });
            throw error;
          } finally {
            active.delete(running.id);
            // The stop aborted it before it finished.
            if (stopping && running.signal.aborted) released.set(running.id, name);
          }
        },
      );
      if (job.schedule !== undefined) {
        // Once a day at most is missed while the install is down; the next start sends it once.
        await queue.boss.schedule(name, job.schedule, {}, { tz: "UTC", missed: "once" });
      }
    }
  } catch (error) {
    await queue.stop({ timeoutMs: 0 });
    await services.database.$client.end();
    throw error;
  }
  const count = options.jobs.length;
  logger.info(`worker: started, working ${count} queue${count === 1 ? "" : "s"}`, {
    queues: options.jobs.map(({ type }) => type.queue),
  });
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      await queue.stop({ timeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS });
      await services.database.$client.end();
      for (const [id, name] of active) released.set(id, name);
      if (released.size === 0) {
        logger.info("worker: stopped");
        return;
      }
      logger.info(
        released.size === 1
          ? "worker: stopped; released 1 active job, which runs again after the restart"
          : `worker: stopped; released ${released.size} active jobs, which run again after the restart`,
        { released: [...released].map(([jobId, queue]) => ({ queue, jobId })) },
      );
    },
  };
}

/** The ids in a job's data: its fields named ...Id or ...Ids, and nothing else of it. */
function idsOf(data: JobData): Record<string, unknown> {
  const ids: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!/(Id|Ids)$/.test(key)) continue;
    const isId = (item: unknown) => typeof item === "number" || (typeof item === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(item));
    if (isId(value) || (Array.isArray(value) && value.every(isId))) ids[key] = value;
  }
  return ids;
}
