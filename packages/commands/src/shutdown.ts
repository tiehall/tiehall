// The process's shutdown (self-host-install: A restart stops the app
// gracefully; requester-loop: The long-poll wait endpoint; design.md,
// Technical decisions: T15). When the web role starts to stop, it gives this
// signal, and every wait the app holds open ends at once with 503 and
// Retry-After: 0, so the role's drain does not wait out a long-poll. The web
// role and the Next.js server it loads run in one process, but each may load
// its own copy of this module, so the signal is kept on the process's global
// object, under a key both copies share.

const KEY = Symbol.for("tiehall.shutdown");

function controller(): AbortController {
  const global = globalThis as { [KEY]?: AbortController };
  global[KEY] ??= new AbortController();
  return global[KEY];
}

/** The process's shutdown signal, aborted once the process starts to stop. */
export function shutdownSignal(): AbortSignal {
  return controller().signal;
}

/** Gives the process's shutdown signal, once the process starts to stop. */
export function startShutdown(): void {
  controller().abort();
}
