import process from "node:process";
import { startWorker, WORKER_JOBS, type JobData, type WorkerJob } from "@tiehall/commands";
import type { Config } from "./config.ts";

// The worker role (design.md, Technical decisions: T6; self-host-install: A
// restart stops the app gracefully): it works the job queues as the app's
// database user until SIGTERM or SIGINT, then stops the worker, which lets
// active jobs finish within its stop timeout and releases the rest, and exits
// 0. It exits 1, saying why, when it cannot start, such as when the migrate
// step has not installed the job queue's schema.

export interface WorkerRoleOptions {
  /** The jobs to run; the worker role runs every job the app defines. */
  jobs?: readonly WorkerJob<JobData>[];
  stopTimeoutMs?: number;
  pollingIntervalSeconds?: number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export async function runWorkerRole(config: Config, options: WorkerRoleOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  let worker;
  try {
    worker = await startWorker({
      connection: {
        connectionString: config.databaseUrl,
        ...(config.databasePassword === undefined ? {} : { password: config.databasePassword }),
      },
      jobs: options.jobs ?? WORKER_JOBS,
      ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
      ...(options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
      log,
    });
  } catch (error) {
    // Startup failures name a connection or the job queue's schema, never a password or a job's data.
    logError(`tiehall worker: failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logError(`tiehall worker: stop failed: ${error instanceof Error ? error.name : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
