import { hookLine, noticeEventType, noticeKey, noticeTeam, noticeUrl, type Notice } from "@tiehall/packet/notices";
import { sleepOf, UnreachableError, type CliEnvironment } from "./environment.ts";
import { chooseLogin, configDirOf } from "./logins.ts";
import { sessionFor, type Answer, type Session } from "./session.ts";
import { acquireSessionLock, releaseSessionLock } from "./session-lock.ts";

// The commands the Claude Code plugin's hooks run (requester-loop: Claude Code
// Stop-hook waiter; agent-surfaces: CLI contract and hook commands;
// agent-safety: Notices that can reach a model carry only server text;
// design.md, Technical decisions: T15). Claude Code runs them for itself, and
// what they write can reach Claude unasked, so they write only Tiehall's own
// text, and nothing at all when they cannot do their work: no saved login, an
// install that refuses them, a CLI older than the install supports. They read
// from the install whose URL the plugin was given, which the plugin's
// launcher passes as --install, and Claude Code's input on their standard
// input names the session.
//
// `tiehall hook wait`, which the Stop hook runs with asyncRewake at the end
// of every turn, waits for news on the user's requests. It long-polls the wait
// endpoint, GET /api/v1/events/wait, with the CLI client's cursor, calling
// again after an empty answer, and after a 503 while the install restarts,
// within a cap of 30 minutes from when it started, which the CLI enforces.
// When news comes, it exits with code 2 and writes a reminder to its error
// output, which wakes Claude: a line of Tiehall's words and one line per
// update, the request key, the event type, the team and the request URL, and
// nothing anyone wrote. It holds the lock of its Claude Code session
// (session-lock.ts), which a waiter armed at the end of a later turn, or the
// session's end, takes from it; then, at the cap, when the install refuses it,
// and when the Claude Code that started it has stopped, it exits without code
// 2 and without a word. `tiehall hook session-end`, which the SessionEnd hook
// runs, ends the session's waiter and frees its lock.

/** How long a waiter waits at most, from when it starts. */
export const WAITER_CAP_MS = 30 * 60_000;

/**
 * The cap of this waiter: 30 minutes, or less when TIEHALL_HOOK_WAIT_CAP_SECONDS
 * names fewer seconds, as a check of the hooks in a real Claude Code session
 * may, so as not to wait half an hour for the cap; it never raises the cap.
 */
export function waiterCapOf(env: CliEnvironment["env"]): number {
  const seconds = Number(env["TIEHALL_HOOK_WAIT_CAP_SECONDS"]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, WAITER_CAP_MS) : WAITER_CAP_MS;
}

/** How long one call to the wait endpoint may take before the waiter gives it up; the install holds one for 60 seconds. */
const CALL_LIMIT_MS = 90_000;

/** How often a waiter checks that the Claude Code that started it still runs. */
const PARENT_CHECK_MS = 5_000;

/** How long a waiter waits before it tries again after a failed call, one after the other, the last from then on. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** How long to wait before trying again after this many failed calls in a row. */
function backoffAfter(failures: number): number {
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 30_000;
}

/** How long a hook waits for Claude Code's input on its standard input, in real time. */
const INPUT_MS = 2_000;

/** The reminder's first line, in Tiehall's words, before one line per update. */
export const REMINDER_HEADING = "Tiehall: news on your requests. Read it with whats_new, or run tiehall updates, and acknowledge what you have handled.";

/** Claude Code's input to a hook, as far as the hooks read it: the session it runs for. */
interface HookInput {
  sessionId?: string;
}

/** The session a hook runs for, from Claude Code's input on its standard input; none when there is none. */
async function hookInputOf(environment: CliEnvironment): Promise<HookInput> {
  let text = "";
  try {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(""), INPUT_MS);
      timer.unref();
    });
    text = await Promise.race([environment.stdin?.() ?? Promise.resolve(""), late]);
    clearTimeout(timer);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { session_id?: unknown };
    const sessionId = parsed?.session_id;
    return typeof sessionId === "string" && sessionId !== "" && sessionId.length <= 256 ? { sessionId } : {};
  } catch {
    return {};
  }
}

/** An entry of the wait endpoint's answer, as the install sends it. */
interface WaitEntry {
  seq?: unknown;
  type?: unknown;
  request_key?: unknown;
  team_key?: unknown;
  url?: unknown;
}

/**
 * The notices of the entries of a wait's answer: each entry's key, event
 * type, team and URL, checked to have the form each has, and its URL to be
 * the request's on the install the CLI is signed in to. An entry that fails a
 * check is left out, so no text reaches a notice through a field.
 */
export function noticesOf(installUrl: string, entries: readonly WaitEntry[]): { seq: number; notice: Notice }[] {
  const notices: { seq: number; notice: Notice }[] = [];
  for (const entry of entries) {
    try {
      if (typeof entry.seq !== "number" || typeof entry.type !== "string" || typeof entry.request_key !== "string" || typeof entry.team_key !== "string") continue;
      const key = noticeKey(entry.request_key);
      const url = noticeUrl(installUrl, key);
      if (entry.url !== url) continue;
      notices.push({ seq: entry.seq, notice: { key, eventType: noticeEventType(entry.type), team: noticeTeam(entry.team_key), url } });
    } catch {
      continue;
    }
  }
  return notices;
}

/** What one call to the wait endpoint came to. */
type Waited =
  | { kind: "answered"; entries: WaitEntry[]; cursor: number }
  | { kind: "again"; afterMs: number | undefined }
  | { kind: "failed" }
  | { kind: "refused" }
  | { kind: "stopped" };

/** How long a 503's Retry-After says to wait; undefined when it says nothing the CLI reads. */
function retryAfterMs(answer: Answer): number | undefined {
  const value = answer.headers.get("retry-after");
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** One call to the wait endpoint, after this cursor, or the client's own when none is given; given up when `stop` aborts. */
export async function waitOnce(environment: CliEnvironment, session: Session, cursor: number | undefined, stop: AbortSignal): Promise<Waited> {
  if (stop.aborted) return { kind: "stopped" };
  const call = new AbortController();
  const onStop = () => call.abort();
  stop.addEventListener("abort", onStop, { once: true });
  void sleepOf(environment)(CALL_LIMIT_MS, call.signal).then(() => call.abort());
  try {
    const answer = await session.send((client) =>
      client.GET("/api/v1/events/wait", { params: { query: cursor === undefined ? {} : { cursor } }, signal: call.signal }),
    );
    if (answer.ok) {
      const body = answer.body as { events?: unknown; cursor?: unknown } | undefined;
      if (!Array.isArray(body?.events) || typeof body.cursor !== "number") return { kind: "failed" };
      return { kind: "answered", entries: body.events as WaitEntry[], cursor: body.cursor };
    }
    if (answer.status === 503 || answer.status === 429) return { kind: "again", afterMs: retryAfterMs(answer) };
    if (answer.status >= 500) return { kind: "failed" };
    return { kind: "refused" };
  } catch (error) {
    if (stop.aborted) return { kind: "stopped" };
    // A call that did not reach the install, or that it held longer than it holds one, is tried again later.
    if (error instanceof UnreachableError) return { kind: "failed" };
    return { kind: "refused" };
  } finally {
    call.abort();
    stop.removeEventListener("abort", onStop);
  }
}

/**
 * Waits for news on the user's requests after the CLI client's cursor, until
 * `stop` aborts: the notices of the first answer that has any, or none once
 * it stops or the install refuses it.
 */
async function waitForNews(environment: CliEnvironment, session: Session, stop: AbortSignal): Promise<{ seq: number; notice: Notice }[]> {
  const sleep = sleepOf(environment);
  let cursor: number | undefined;
  let failures = 0;
  while (!stop.aborted) {
    const waited = await waitOnce(environment, session, cursor, stop);
    switch (waited.kind) {
      case "answered": {
        failures = 0;
        const notices = noticesOf(session.url, waited.entries);
        if (notices.length > 0) return notices;
        cursor = waited.cursor;
        break;
      }
      case "again":
        // A restart's Retry-After: 0 is taken at its word the first time; a 503 that comes again waits longer each time.
        await sleep(failures === 0 ? (waited.afterMs ?? backoffAfter(0)) : Math.max(waited.afterMs ?? 0, backoffAfter(failures)), stop);
        failures += 1;
        break;
      case "failed":
        await sleep(backoffAfter(failures), stop);
        failures += 1;
        break;
      case "refused":
      case "stopped":
        return [];
    }
  }
  return [];
}

/** Stops the waiter when the process that started it, the Claude Code of its session, no longer runs. */
async function watchParent(environment: CliEnvironment, stop: AbortController): Promise<void> {
  const alive = environment.parentAlive;
  if (alive === undefined) return;
  const sleep = sleepOf(environment);
  while (!stop.signal.aborted) {
    await sleep(PARENT_CHECK_MS, stop.signal);
    if (!stop.signal.aborted && !alive()) stop.abort();
  }
}

/** The reminder that wakes Claude: Tiehall's words, then a line for each update. */
function reminderOf(notices: readonly { notice: Notice }[]): string {
  return `${[REMINDER_HEADING, ...notices.map(({ notice }) => hookLine(notice))].join("\n")}\n`;
}

/** `tiehall hook wait`: waits for news for up to 30 minutes; 2 with the reminder when it comes, 0 without a word otherwise. */
export async function hookWait(environment: CliEnvironment, install: string | undefined): Promise<number> {
  const stop = new AbortController();
  let release: (() => void) | undefined;
  try {
    const input = await hookInputOf(environment);
    const configDir = configDirOf(environment.env);
    const login = chooseLogin(configDir, { install });
    const lock = await acquireSessionLock(configDir, input.sessionId ?? "no-session");
    if (lock === undefined) return 0;
    release = () => lock.close();
    lock.released.addEventListener("abort", () => stop.abort(), { once: true });
    void sleepOf(environment)(waiterCapOf(environment.env), stop.signal).then(() => stop.abort());
    void watchParent(environment, stop);
    const notices = await waitForNews(environment, sessionFor(environment, login, { longRunning: true }), stop.signal);
    if (notices.length === 0) return 0;
    environment.stderr(reminderOf(notices));
    return 2;
  } catch {
    // Nothing a hook cannot do reaches Claude: its error output holds the reminder or nothing.
    return 0;
  } finally {
    stop.abort();
    release?.();
  }
}

/** `tiehall hook session-end`: ends the session's waiter and frees its lock, without a word. */
export async function hookSessionEnd(environment: CliEnvironment): Promise<number> {
  try {
    const input = await hookInputOf(environment);
    await releaseSessionLock(configDirOf(environment.env), input.sessionId ?? "no-session");
  } catch {
    // The session ends whatever happens here.
  }
  return 0;
}

/** The hook commands, with their usage and what they do, as `tiehall hook` lists them. */
export const HOOK_COMMANDS: readonly { command: string; summary: string }[] = [
  {
    command: "hook wait",
    summary:
      "For the Claude Code plugin's Stop hook: wait up to 30 minutes for news on your requests, and exit with code 2, which wakes Claude, with its request keys, event types, teams and URLs.",
  },
  { command: "hook session-end", summary: "For the Claude Code plugin's SessionEnd hook: stop the session's waiter and free its lock." },
];
