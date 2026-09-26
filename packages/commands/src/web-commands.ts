import { httpProblem, internalErrorProblem, Refusal, type ProblemDetails } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";
import { assertWebWrite, csrfTokenFor, type WebWriteRequest } from "./web-writes.ts";

// The web UI's authorization path (public-api: One definition per operation,
// the same on every surface; agent-safety: One confirmation approves one
// action; design.md, Technical decisions: T3; design.md, Self-hosting
// decisions: S7). Server actions and server components never touch the
// database themselves: they run operations through execute(), in the web
// process, as the signed-in user's web session, so the web UI parses input,
// applies the caller's rules and runs the handler exactly as REST, MCP and the
// CLI do, and has no rights the same user lacks there.
// - A server component's read runs in a read-only transaction, so a page's
//   GET can never change anything, whatever operation it names.
// - A server action's write, a rejection among them, first passes the checks
//   every web UI write passes: the session's CSRF token, an Origin equal to
//   TIEHALL_URL and Sec-Fetch-Site: same-origin; a write that fails one gets
//   403 and runs nothing. An action that needs the confirmation step is
//   applied only from its review page, with its nonce, so a server action
//   that carries the session and the CSRF token alone gets 403 from execute().
// What a call gives back is the operation's output, or the same RFC 9457
// problem the REST route answers with: a refusal as the error model gives it,
// 401 without a signed-in user, and for any other failure a 500 that says
// nothing about it, logged by its name and stack, never its message.

/** An operation's outcome, as a server action or a server component gets it. */
export type WebResult<Output = unknown> = { ok: true; output: Output } | { ok: false; problem: ProblemDetails };

export interface WebCommandOptions {
  execute: Execute;
  /** The signed-in user's web session, from the request's session cookie; undefined when nobody is signed in. */
  session(): Promise<WebSessionCaller | undefined>;
  /** The install's URL (TIEHALL_URL), as its origin, which a write's Origin must equal. */
  url: string;
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the CSRF tokens; read when it is first needed. */
  secret: () => string;
  logger?: Logger;
}

export interface WebCommands {
  /** Runs an operation for a server component, as the signed-in user's web session, in a read-only transaction. */
  read<Output = unknown>(commandId: string, input: unknown): Promise<WebResult<Output>>;
  /** Runs an operation for a server action, once the request has passed the web UI's write checks. */
  write<Output = unknown>(
    commandId: string,
    input: unknown,
    request: WebWriteRequest,
    options?: Pick<ExecuteOptions, "origin">,
  ): Promise<WebResult<Output>>;
  /** The CSRF token a page puts in its forms, for the signed-in user's web session; undefined when nobody is signed in. */
  csrfToken(): Promise<string | undefined>;
}

export function createWebCommands(options: WebCommandOptions): WebCommands {
  const logger = options.logger ?? createLogger();

  async function signedIn(): Promise<WebSessionCaller> {
    const caller = await options.session();
    if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to do this.");
    return caller;
  }

  async function outcome<Output>(commandId: string, run: () => Promise<unknown>): Promise<WebResult<Output>> {
    try {
      return { ok: true, output: (await run()) as Output };
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, problem: httpProblem(error).body };
      logger.error("web: the operation failed", { operationId: commandId, error });
      return { ok: false, problem: internalErrorProblem().body };
    }
  }

  return {
    read(commandId, input) {
      return outcome(commandId, async () => options.execute(commandId, await signedIn(), input, { readOnly: true }));
    },
    write(commandId, input, request, runOptions = {}) {
      return outcome(commandId, async () => {
        const caller = await signedIn();
        assertWebWrite(request, { url: options.url, secret: options.secret(), sessionId: caller.sessionId, confirm: false });
        return options.execute(commandId, caller, input, runOptions);
      });
    },
    async csrfToken() {
      const caller = await options.session();
      return caller === undefined ? undefined : csrfTokenFor(options.secret(), caller.sessionId);
    },
  };
}
