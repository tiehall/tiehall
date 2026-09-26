import { httpProblem, internalErrorProblem, Refusal, type ProblemDetails } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";

// The web UI's authorization path (public-api: One definition per operation,
// the same on every surface; design.md, Technical decisions: T3). Server
// actions and server components never touch the database themselves: they
// run operations through execute(), in the web process, as the signed-in
// user's web session, so the web UI parses input, applies the caller's rules
// and runs the handler exactly as REST, MCP and the CLI do, and has no rights
// the same user lacks there. What a call gives back is the operation's
// output, or the same RFC 9457 problem the REST route answers with: a
// refusal as the error model gives it, 401 without a signed-in user, and for
// any other failure a 500 that says nothing about it, logged by its name and
// stack, never its message.

/** An operation's outcome, as a server action or a server component gets it. */
export type WebResult<Output = unknown> = { ok: true; output: Output } | { ok: false; problem: ProblemDetails };

export interface WebCommandOptions {
  execute: Execute;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(): Promise<WebSessionCaller | undefined>;
  logger?: Logger;
}

export interface WebCommands {
  /** Runs an operation as the signed-in user's web session. */
  run<Output = unknown>(commandId: string, input: unknown, options?: Pick<ExecuteOptions, "confirmation" | "origin">): Promise<WebResult<Output>>;
}

export function createWebCommands(options: WebCommandOptions): WebCommands {
  const logger = options.logger ?? createLogger();
  return {
    async run<Output>(commandId: string, input: unknown, runOptions: Pick<ExecuteOptions, "confirmation" | "origin"> = {}) {
      try {
        const caller = await options.session();
        if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to do this.");
        return { ok: true, output: (await options.execute(commandId, caller, input, runOptions)) as Output };
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, problem: httpProblem(error).body };
        logger.error("web: the operation failed", { operationId: commandId, error });
        return { ok: false, problem: internalErrorProblem().body };
      }
    },
  };
}
