// What one run of the CLI is given in place of its process's (agent-surfaces:
// The CLI package): its arguments, its environment variables, where it writes
// its output, its standard input, how it reaches the network, how it waits and
// tells the time, and whether the process that started it still runs. The
// `tiehall` command gives it the process's own; a test gives it its own, such
// as a fetch that reaches a test install or a clock it moves by hand.

export interface CliEnvironment {
  /** The arguments after `tiehall`. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The whole standard input, for an option given as `-` or a hook's input; none when the run has none. */
  stdin?(): Promise<string>;
  /** Sends one call; the global fetch unless given. */
  fetch?(request: Request): Promise<Response>;
  /** Waits this long, such as between the polls of `tiehall login`, or until the signal aborts, whichever comes first. */
  sleep?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /** The clock; the system's unless given. */
  now?(): Date;
  /** Whether the process that started this one still runs, such as the Claude Code that runs a hook; true unless given. */
  parentAlive?(): boolean;
}

/** A refusal of the CLI's own, before or instead of a call: its message says why and what to do, and the run exits with 1. */
export class CliError extends Error {
  override name = "CliError";
}

/** A call that did not reach the install, or that it could not answer for now, such as while it restarts: trying again later may work. */
export class UnreachableError extends CliError {
  override name = "UnreachableError";
}

/** How a run waits: the environment's sleep, or a timer that the signal ends early. */
export function sleepOf(environment: CliEnvironment): (milliseconds: number, signal?: AbortSignal) => Promise<void> {
  if (environment.sleep !== undefined) return (milliseconds, signal) => environment.sleep!(milliseconds, signal);
  return (milliseconds, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      signal?.addEventListener("abort", done, { once: true });
    });
}

/** The time now, by the environment's clock. */
export function nowOf(environment: CliEnvironment): Date {
  return environment.now?.() ?? new Date();
}
