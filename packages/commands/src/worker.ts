import { openDatabase, type Database, type DatabaseConnection } from "@tiehall/db";
import { openJobQueue } from "./job-queue.ts";
import type { DefinedJobType, JobData } from "./jobs.ts";

// The worker role (design.md, Technical decisions: T6; self-host-install: A
// restart stops the app gracefully). It works the queues of the job types it
// knows, as the app role, and supervises the queues. On stop, which SIGTERM
// triggers, it takes no new job and gives its active jobs up to the stop
// timeout to finish; the job queue releases the ones still running, so they
// run again once a worker starts after the restart, and no job is lost. A
// released job counts as one of its attempts.

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
  log?: (line: string) => void;
}

export interface Worker {
  /** Stops taking jobs, lets active ones finish within the stop timeout, releases the rest, and disconnects. */
  stop(): Promise<void>;
}

/** Well within the 30 seconds Compose waits after SIGTERM before it kills the container. */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const log = options.log ?? console.log;
  const queue = await openJobQueue({
    connection: options.connection,
    jobTypes: options.jobs.map(({ type }) => type),
    supervise: true,
    applicationName: "tiehall worker",
    log,
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
            log(`worker: job ${running.id} on ${name} failed (${error instanceof Error ? error.name : typeof error})`);
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
  log(`worker: started, working ${count} queue${count === 1 ? "" : "s"}`);
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      await queue.stop({ timeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS });
      await services.database.$client.end();
      for (const [id, name] of active) released.set(id, name);
      if (released.size === 0) {
        log("worker: stopped");
        return;
      }
      const jobs = [...released].map(([id, name]) => `${name} ${id}`).join(", ");
      log(
        released.size === 1
          ? `worker: stopped; released 1 active job, which runs again after the restart: ${jobs}`
          : `worker: stopped; released ${released.size} active jobs, which run again after the restart: ${jobs}`,
      );
    },
  };
}
