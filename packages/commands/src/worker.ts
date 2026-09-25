export interface Worker {
  /** Stops taking work and resolves once the worker has let go of everything it held. */
  stop(): Promise<void>;
}

/**
 * The worker role's entry point. Task 3.7 adds pg-boss (queues, crons, and a
 * stop that finishes or releases active jobs); until then the worker has no
 * queues and only holds the process open until it is stopped.
 */
export function startWorker(log: (line: string) => void = console.log): Worker {
  const idle = setInterval(() => {}, 60_000);
  log("worker: started, with no queues yet");
  return {
    async stop() {
      clearInterval(idle);
      log("worker: stopped");
    },
  };
}
