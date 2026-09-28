import process from "node:process";
import {
  createLogger,
  openMailer,
  openSecretBox,
  startWorker,
  WORKER_JOBS,
  type AppSettings,
  type JobData,
  type Logger,
  type SecretBox,
  type WorkerJob,
} from "@tiehall/commands";

// The worker role (design.md, Technical decisions: T6; self-host-install: A
// restart stops the app gracefully): it works the job queues as the app's
// database user until SIGTERM or SIGINT, then stops the worker, which lets
// active jobs finish within its stop timeout and releases the rest, and exits
// 0. It exits 1, saying why, when it cannot start, such as when the migrate
// step has not installed the job queue's schema. It logs JSON lines on
// standard output (self-host-install: Logs carry ids, never message text or
// credentials).

export interface WorkerRoleOptions {
  /** The jobs to run; the worker role runs every job the app defines. */
  jobs?: readonly WorkerJob<JobData>[];
  stopTimeoutMs?: number;
  pollingIntervalSeconds?: number;
  logger?: Logger;
}

export async function runWorkerRole(settings: Pick<AppSettings, "database" | "url" | "smtp" | "secretKey">, options: WorkerRoleOptions = {}): Promise<void> {
  const logger = options.logger ?? createLogger().child({ role: "worker" });
  // TIEHALL_SECRET_KEY opens the GitHub App's stored private key, when a job first calls GitHub.
  let box: SecretBox | undefined;
  const starting = startWorker({
    secrets: () => (box ??= openSecretBox(settings.secretKey)),
    connection: settings.database,
    jobs: options.jobs ?? WORKER_JOBS,
    // Email goes out through the install's SMTP settings, or, without them, nowhere.
    mailer: openMailer(settings.smtp),
    installUrl: settings.url,
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    ...(options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    logger,
  });
  // The signal handlers go on before the start finishes: the worker logs "started" from inside the start, and
  // a SIGTERM that arrived between that line and the handler's registration would end the process with the
  // signal's default action, not gracefully. A stop that comes early waits for the start, then stops.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    starting.then((worker) => worker.stop()).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("tiehall worker: stop failed", { error });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await starting;
  } catch (error) {
    // A start fails before any job runs, on the connection or the job queue's schema, so its reason holds no
    // job's data; the logger still drops credentials from it.
    logger.error(`tiehall worker: failed to start: ${error instanceof Error ? error.message : String(error)}`, { error });
    process.exit(1);
  }
}
