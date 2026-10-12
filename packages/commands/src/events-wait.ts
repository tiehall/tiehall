import { waitForEvents, type waitEntry } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import type { z } from "zod";
import { actsForUser, type Caller } from "./caller.ts";
import { cursorOf, readerOf } from "./event-reads.ts";
import { definePreparedHandler, type Handlers, type PrepareContext } from "./execute.ts";
import { shutdownSignal } from "./shutdown.ts";
import { updatesAfter, updatesPageOf } from "./updates.ts";

// The long-poll wait endpoint, GET /api/v1/events/wait (requester-loop: The
// long-poll wait endpoint; requester-loop: What whats_new covers; requests:
// Readers get only domain events they may see; self-host-install: A restart
// stops the app gracefully; design.md, Decisions this change rests on: D28
// #59; design.md, Technical decisions: T15). It takes a cursor, the reader's
// own unless the call names one, and answers as soon as an update in the
// user's whats_new scope comes after it, the one the wait's reader, such as
// the Claude Code hooks through the CLI, pulls next: each entry is the
// update's seq and type, its request's key, the key of the request's target
// team and the request's URL, ids and Tiehall's own text only, and the cursor
// is the last entry's seq. Otherwise it holds the call at most 60 seconds and
// answers 200 with an empty list and the cursor it was given. It moves no
// cursor.
//
// It holds the call in the step execute() runs before the call's transaction,
// so no connection or transaction is held while it waits: it reads in short
// read-only transactions, taking a wake-up before each read so an event that
// commits meanwhile still wakes it (event-wakeups.ts), and reads again when
// woken, on its own every few seconds, and when the hold ends. Security events
// send no wake-up and are never updates, and an update outside the user's
// scope wakes the wait only to find nothing, so it holds on. While the app
// shuts down, a wait ends at once with 503 and Retry-After: 0, whether the
// shutdown comes while it holds or while it reads, as does a wait that starts
// then, and the client calls again once the app is back.

/** How long a wait holds when no update comes: 60 seconds. */
export const WAIT_HOLD_MS = 60_000;

/** How often a waiting call reads again on its own, should a wake-up be lost with a lost listening connection; the live hall's wait does too (hall.ts). */
export const RECHECK_MS = 5_000;

/** How many updates one answer lists at most. */
const WAIT_ENTRIES = 50;

type WaitAnswer = { events: z.input<typeof waitEntry>[]; cursor: number };

/** The refusal a wait ends with while the app shuts down: 503 with Retry-After: 0. */
export function shuttingDown(): Refusal {
  return new Refusal("shutting-down", "Tiehall is shutting down. Call the wait again; it is answered once Tiehall is back.");
}

/** The user a caller acts for; only a caller that acts for a user waits. */
function userOf(caller: Caller): string {
  if (!actsForUser(caller)) throw new Refusal("forbidden", "Only a caller that acts for a user waits for updates.");
  return caller.userId;
}

/** Holds until the wake-up, the time or the shutdown, whichever comes first; says which. A shutdown that began before it holds ends it at once. */
export function held(woken: Promise<void> | undefined, ms: number, shutdown: AbortSignal): Promise<"woken" | "time" | "shutdown"> {
  if (shutdown.aborted) return Promise.resolve("shutdown");
  return new Promise((resolve) => {
    const done = (outcome: "woken" | "time" | "shutdown") => {
      clearTimeout(timer);
      shutdown.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => done("shutdown");
    const timer = setTimeout(() => done("time"), ms);
    shutdown.addEventListener("abort", onAbort, { once: true });
    void woken?.then(() => done("woken"));
  });
}

/** Waits, outside any transaction, until an update in the user's scope comes after the cursor, the hold ends or the app shuts down. */
async function waitStep({ cursor: given }: { cursor?: number | undefined }, context: PrepareContext): Promise<WaitAnswer> {
  const shutdown = context.waits?.shutdown ?? shutdownSignal();
  if (shutdown.aborted) throw shuttingDown();
  const installUrl = context.url;
  if (installUrl === undefined) throw new Error("The wait names each request's URL, so it runs only where the install's URL is known.");
  const userId = userOf(context.caller);
  const cursor = given ?? (await context.read((read) => cursorOf(read, userId, readerOf(context.caller))));
  const deadline = Date.now() + (context.waits?.holdMs ?? WAIT_HOLD_MS);
  const wakeups = context.waits?.wakeups;
  await wakeups?.ready();
  for (;;) {
    const wake = wakeups?.next();
    try {
      const found = await context.read(async (read) => {
        const { events } = await updatesAfter(read, { userId, scope: "whats_new", after: cursor, limit: WAIT_ENTRIES });
        return (await updatesPageOf(read, { events, more: false, cursor, installUrl })).events;
      });
      if (found.length > 0) {
        return {
          events: found.map(({ number, type, request }) => ({ seq: number, type, requestKey: request.key, teamKey: request.targetTeam.key, url: request.url })),
          cursor: found.at(-1)?.number ?? cursor,
        };
      }
      // A shutdown that began while the wait read, between its holds, ends it as one that comes while it holds does.
      if (shutdown.aborted) throw shuttingDown();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { events: [], cursor };
      if ((await held(wake?.woken, Math.min(remaining, RECHECK_MS), shutdown)) === "shutdown") throw shuttingDown();
    } finally {
      wake?.cancel();
    }
  }
}

export const WAIT_HANDLERS: Handlers = {
  [waitForEvents.id]: definePreparedHandler(waitForEvents, waitStep, async (_input, context) => context.prepared),
};
