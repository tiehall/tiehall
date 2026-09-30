import { listen, type DatabaseConnection, type Listener } from "@tiehall/db";
import type { Logger } from "./log.ts";

// Wake-ups when events commit (requester-loop: The long-poll wait endpoint;
// design.md, Design rules: Requester loop; design.md, Technical decisions:
// T15). Every domain event is appended with a notification on one channel,
// sent by Postgres when its transaction commits, whose payload is the event's
// number and nothing else (append-event.ts). One connection per process
// listens on that channel, outside the pool, and wakes every wait that is
// holding, which then reads again whether an update in its reader's scope
// came: a notification says only that something committed, never what, so no
// text travels through it. A wait subscribes before it reads, so an event that
// commits between its read and its hold still wakes it. Should the listening
// connection be lost, every wait is woken to read again, the connection is
// opened again after a moment, and until then the waits read again every few
// seconds on their own.

/** The channel the event log's notifications are sent on. */
export const EVENTS_CHANNEL = "tiehall_events";

/** How long the hub waits before it opens a lost listening connection again. */
const RECONNECT_MS = 1_000;

/** One wait's wake-up at the next event that commits. */
export interface WakeUp {
  /** Resolves at the next notification after the wake-up was taken, or when the listening connection is lost. */
  readonly woken: Promise<void>;
  /** Drops the wake-up, once the wait no longer holds. */
  cancel(): void;
}

export interface EventWakeups {
  /** Starts listening, once, and resolves once the channel is heard; a failure is logged, and the waits then read again on their own. */
  ready(): Promise<void>;
  /** A wake-up at the next event that commits from now on. */
  next(): WakeUp;
  close(): Promise<void>;
}

export function createEventWakeups(connection: DatabaseConnection, options: { logger: Logger; applicationName?: string }): EventWakeups {
  const { logger } = options;
  const waiting = new Set<() => void>();
  let listener: Listener | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const wakeAll = () => {
    const woken = [...waiting];
    waiting.clear();
    for (const wake of woken) wake();
  };

  const start = (): Promise<void> => {
    starting ??= listen(connection, EVENTS_CHANNEL, {
      applicationName: options.applicationName ?? "tiehall event wake-ups",
      onNotification: wakeAll,
      onLost: (error) => {
        logger.warn("events: the connection that listens for events was lost; listening again shortly", { error });
        listener = undefined;
        starting = undefined;
        wakeAll();
        if (!closed) retry = setTimeout(() => void start(), RECONNECT_MS);
      },
    }).then(
      (opened) => {
        if (closed) {
          void opened.close();
          return;
        }
        listener = opened;
      },
      (error: unknown) => {
        logger.warn("events: the connection that listens for events could not be opened; trying again shortly", { error });
        starting = undefined;
        if (!closed) retry = setTimeout(() => void start(), RECONNECT_MS);
      },
    );
    return starting;
  };

  return {
    ready: () => (listener !== undefined ? Promise.resolve() : start()),
    next() {
      let wake: () => void = () => {};
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      waiting.add(wake);
      return { woken, cancel: () => waiting.delete(wake) };
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      wakeAll();
      await starting;
      await listener?.close();
      listener = undefined;
    },
  };
}
