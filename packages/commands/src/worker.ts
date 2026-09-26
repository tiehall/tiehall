import type { DatabaseConnection } from "@tiehall/db";
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

export interface WorkerJob<D extends JobData> {
  type: DefinedJobType<D>;
  /** Runs one job; a throw fails the attempt, which the queue retries until the retry limit. */
  handle(job: RunningJob<D>): Promise<void>;
  /** How many jobs of this type the worker runs at once. */
  concurrency?: number;
}

/** The jobs the worker role runs. Each task that adds a kind of job adds it here. */
export const WORKER_JOBS: readonly WorkerJob<JobData>[] = [];

export interface WorkerOptions {
  /** The app's connection, as the app role. */
  connection: DatabaseConnection;
  jobs: readonly WorkerJob<JobData>[];
  /** How long active jobs may take to finish once the worker stops; the rest are released. */
  stopTimeoutMs?: number;
  /** How often each queue is polled for new jobs. */
  pollingIntervalSeconds?: number;
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
            await job.handle({ id: running.id, queue: name, data: running.data, signal: running.signal });
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
    }
  } catch (error) {
    await queue.stop({ timeoutMs: 0 });
    throw error;
  }
  const count = options.jobs.length;
  log(`worker: started, working ${count} queue${count === 1 ? "" : "s"}`);
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      await queue.stop({ timeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS });
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
