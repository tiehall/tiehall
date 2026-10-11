import { readHallState, waitForHall } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, type HttpProblem } from "@tiehall/core";
import type { WebSessionCaller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import { hallJsonPolicy } from "./html.ts";
import { createLogger, type Logger } from "./log.ts";

// The live hall's reads as its script calls them (web-ui: The live hall's
// reads and its long-poll; web-ui: The content security policy of each kind
// of page; requester-loop: No push paths other than the hooks; design.md,
// Design: The live hall; D57 (9), (12)). GET /hall/state answers hall.state
// and GET /hall/wait?after=<cursor> answers hall.wait, both with the page's
// team and agents, each as one complete JSON document, never a stream, with
// no-store, nosniff, same-origin and the JSON answers' policy. They take the
// web session's cookie alone: an Authorization header is never read, so an
// agent's token gets the same 401 as no credentials, and a removed member's
// session gets 403. They read the session without renewing it, as a server
// component does (session-renewal.ts): they are reads the page makes on its
// own, not uses by the person, and an unattended hall, such as one on a wall
// screen, would otherwise keep its session alive to its 30-day cap. A
// refusal is the error model's problem, the wait's 503 with Retry-After: 0
// while the app shuts down among them, and any other failure a 500 that says
// nothing about it.

export const HALL_STATE_PATH = "/hall/state";
export const HALL_WAIT_PATH = "/hall/wait";

export interface HallReadOptions {
  execute: Execute;
  /** The signed-in user's web session, from the request's session cookie; read without renewing it. */
  session(request: Request): Promise<WebSessionCaller | undefined>;
  logger?: Logger;
}

/** The headers of every answer of the hall's reads, a refusal's included. */
const HALL_JSON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": hallJsonPolicy(),
} as const;

function problem({ status, headers, body }: HttpProblem): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...HALL_JSON_HEADERS } });
}

/** The page's narrowing in its address: a team's key, and agents=1 for what agents did; the page and its reads share it. */
export function hallNarrowingOf(query: URLSearchParams): { team?: string; agents?: boolean } {
  const team = query.get("team");
  return { ...(team === null || team === "" ? {} : { team }), ...(query.get("agents") === "1" ? { agents: true } : {}) };
}

/** A read of the hall at its path, which runs the command as the session's user with the input the address gives. */
function hallRead(options: HallReadOptions, name: string, commandId: string, inputOf: (query: URLSearchParams) => unknown): (request: Request) => Promise<Response> {
  const logger = options.logger ?? createLogger();
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Refusal("route-not-found", "There is no such page here.");
      const caller = await options.session(request);
      if (caller === undefined) throw new Refusal("unauthenticated", "Sign in to Tiehall to watch the live hall.");
      const answer = await options.execute(commandId, caller, inputOf(new URL(request.url).searchParams), { readOnly: true });
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json", ...HALL_JSON_HEADERS } });
    } catch (error) {
      if (error instanceof Refusal) return problem(httpProblem(error));
      logger.error(`${name}: the read failed`, { error });
      return problem(internalErrorProblem());
    }
  };
}

/** GET /hall/state: what the live hall shows now, narrowed as the page's address says. */
export function createHallStateRoute(options: HallReadOptions): (request: Request) => Promise<Response> {
  return hallRead(options, "the live hall's state", readHallState.id, hallNarrowingOf);
}

/** GET /hall/wait?after=<cursor>: the live hall's long-poll from the cursor, narrowed as the page's address says. */
export function createHallWaitRoute(options: HallReadOptions): (request: Request) => Promise<Response> {
  return hallRead(options, "the live hall's wait", waitForHall.id, (query) => ({ after: query.get("after") ?? undefined, ...hallNarrowingOf(query) }));
}
