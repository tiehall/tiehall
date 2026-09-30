// What one run of the CLI is given in place of its process's (agent-surfaces:
// The CLI package): its arguments, its environment variables, where it writes
// its output, its standard input, how it reaches the network and how it
// waits. The `tiehall` command gives it the process's own; a test gives it
// its own, such as a fetch that reaches a test install.

export interface CliEnvironment {
  /** The arguments after `tiehall`. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The whole standard input, for an option given as `-`; none when the run has none. */
  stdin?(): Promise<string>;
  /** Sends one call; the global fetch unless given. */
  fetch?(request: Request): Promise<Response>;
  /** Waits this long, such as between the polls of `tiehall login`. */
  sleep?(milliseconds: number): Promise<void>;
  /** The clock; the system's unless given. */
  now?(): Date;
}

/** A refusal of the CLI's own, before or instead of a call: its message says why and what to do, and the run exits with 1. */
export class CliError extends Error {
  override name = "CliError";
}
