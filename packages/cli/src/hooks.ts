import { hookLine, noticeEventType, noticeKey, noticeTeam, noticeUrl, type Notice } from "@tiehall/packet/notices";
import { announce, announcedThrough, type MarkOwner } from "./announced.ts";
import { abortable, sleepOf, UnreachableError, type CliEnvironment } from "./environment.ts";
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
// `tiehall hook session-start`, which the SessionStart hook runs, prints a
// digest that is added to Claude's context: a line of Tiehall's words and one
// line per update after the CLI client's cursor that has not been announced,
// the request key, the event type, the team and the request URL, read without
// acknowledging anything; it prints nothing when nothing is new. The digest
// and the waiter share the mark of the news announced (announced.ts): neither
// announces an update the mark holds, and each adds to it what it announces.
// The agent acknowledges through whats_new, whose cursor is its own, so the
// CLI client's cursor can stay behind more announced updates than the
// digest's page holds; then the digest reads past the mark with the wait
// endpoint, as the waiter does, without holding the session's start.
//
// `tiehall hook wait`, which the Stop hook runs with asyncRewake at the end
// of every turn, waits for news on the user's requests. It long-polls the wait
// endpoint, GET /api/v1/events/wait, with the CLI client's cursor, and then
// past what the mark holds, calling again after an empty answer, and after a 503 while the install restarts,
// within a cap of 30 minutes from when it started, which the CLI enforces.
// When news the mark does not hold comes, it exits with code 2 and writes a
// reminder to its error output, which wakes Claude: a line of Tiehall's words and one line per
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

/**
 * How long to wait before calling the wait endpoint again after a call that
 * failed or was answered with a 503, when this many came before it in a row: a
 * restart's Retry-After: 0 is taken at its word the first time, and a failure
 * that comes again waits longer each time.
 */
export function retryDelay(waited: Extract<Waited, { kind: "again" | "failed" }>, failures: number): number {
  if (waited.kind === "failed") return backoffAfter(failures);
  return failures === 0 ? (waited.afterMs ?? backoffAfter(0)) : Math.max(waited.afterMs ?? 0, backoffAfter(failures));
}

/** How long a hook waits for Claude Code's input on its standard input, in real time. */
const INPUT_MS = 2_000;

/** How many updates the digest lists at most: one page of whats_new. */
const DIGEST_LIMIT = 50;

/** How long the digest's read may take, so that a session starts without waiting on an install that does not answer. */
const DIGEST_READ_MS = 10_000;

/** How long the digest's read past the mark may take, which the install answers at once unless nothing it can list is there. */
const PAST_MARK_MS = 3_000;

/** The digest's first line, in Tiehall's words, before one line per update. */
export const DIGEST_HEADING =
  "Tiehall: updates on your requests are waiting. Read them with whats_new, or run tiehall updates, and acknowledge what you have handled.";

/** The digest's last line when more updates wait than it lists. */
export const DIGEST_MORE = "More updates wait after these: whats_new reads them all.";

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
export type Waited =
  | { kind: "answered"; entries: WaitEntry[]; cursor: number }
  | { kind: "again"; afterMs: number | undefined }
  | { kind: "failed" }
  /** The install refused the call, with this problem, or the CLI could not make it, for this reason. */
  | { kind: "refused"; problem?: unknown; error?: Error }
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
    // A refresh of the access token is given up only when the waiter stops, such as at its cap, not when one call runs long.
    // The call ends when its own signal aborts, whatever its request's signal does (abortable()).
    const answer = await abortable(
      session.send((client) => client.GET("/api/v1/events/wait", { params: { query: cursor === undefined ? {} : { cursor } }, signal: call.signal }), stop),
      call.signal,
    );
    if (answer.ok) {
      const body = answer.body as { events?: unknown; cursor?: unknown } | undefined;
      if (!Array.isArray(body?.events) || typeof body.cursor !== "number") return { kind: "failed" };
      return { kind: "answered", entries: body.events as WaitEntry[], cursor: body.cursor };
    }
    if (answer.status === 503 || answer.status === 429) return { kind: "again", afterMs: retryAfterMs(answer) };
    if (answer.status >= 500) return { kind: "failed" };
    return { kind: "refused", problem: answer.body };
  } catch (error) {
    if (stop.aborted) return { kind: "stopped" };
    // A call that did not reach the install, or that it held longer than it holds one, is tried again later.
    if (error instanceof UnreachableError || call.signal.aborted) return { kind: "failed" };
    return { kind: "refused", error: error instanceof Error ? error : new Error(String(error)) };
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
  const configDir = configDirOf(environment.env);
  let cursor: number | undefined;
  let failures = 0;
  while (!stop.aborted) {
    const waited = await waitOnce(environment, session, cursor, stop);
    switch (waited.kind) {
      case "answered": {
        failures = 0;
        const fresh = await announceFresh(configDir, session, noticesOf(session.url, waited.entries), waited.cursor, stop);
        if (fresh !== undefined) return fresh;
        // Everything it answered was announced already: the next call waits past it, and past what the mark holds.
        cursor = Math.max(waited.cursor, announcedThrough(configDir, session));
        break;
      }
      case "again":
      case "failed":
        await sleep(retryDelay(waited, failures), stop);
        failures += 1;
        break;
      case "refused":
      case "stopped":
        return [];
    }
  }
  return [];
}

/**
 * The notices the mark does not hold, which the mark then holds, up to `through`
 * when it is given, such as the cursor of the answer they came in; undefined
 * when the mark holds them all, or when `stop` aborted before the mark's lock
 * was taken, as it does when the waiter's session ends, since then the news
 * reaches nobody and the next session's digest lists it.
 */
export function announceFresh(
  configDir: string,
  owner: MarkOwner,
  notices: readonly { seq: number; notice: Notice }[],
  through?: number,
  stop?: AbortSignal,
): Promise<{ seq: number; notice: Notice }[] | undefined> {
  return announce(configDir, owner, (announced) => {
    if (stop?.aborted === true) return undefined;
    const fresh = notices.filter(({ seq }) => seq > announced);
    if (fresh.length === 0) return undefined;
    return { through: Math.max(through ?? 0, ...fresh.map(({ seq }) => seq)), picked: fresh };
  });
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
export function reminderOf(notices: readonly { notice: Notice }[]): string {
  return `${[REMINDER_HEADING, ...notices.map(({ notice }) => hookLine(notice))].join("\n")}\n`;
}

/** The SessionStart digest: Tiehall's words, a line for each update, and, when more wait past these, Tiehall's words for that. */
export function sessionDigestOf(news: { notices: readonly { notice: Notice }[]; more: boolean }): string {
  return `${[DIGEST_HEADING, ...news.notices.map(({ notice }) => hookLine(notice)), ...(news.more ? [DIGEST_MORE] : [])].join("\n")}\n`;
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
    environment.interrupted?.().addEventListener("abort", () => stop.abort(), { once: true });
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

/** An update of whats_new's answer, as far as the digest reads it: its number and type, and its request's key, target team and URL. */
interface UpdateEntry {
  number?: unknown;
  type?: unknown;
  request?: { key?: unknown; url?: unknown; targetTeam?: { key?: unknown } };
}

/** The updates of a digest: the notices to list, and whether more updates wait after them. */
interface DigestNews {
  notices: { seq: number; notice: Notice }[];
  more: boolean;
}

/**
 * The updates past the mark, which the mark does not hold, and which it then
 * holds; undefined when there are none, or the install does not answer in a
 * moment. The digest reads them once every update of its page was announced
 * and more wait after it. The wait endpoint answers at once when updates come
 * after the cursor it is given, and otherwise holds the call: given the number
 * just before the mark's, it answers at once with the update the mark ends at,
 * which a hook announced as one of the user's, and those after it. Should
 * that update no longer be one of the user's, and nothing come after it, the
 * install holds the read, and the digest gives it up after a moment rather
 * than hold the session's start; the waiter announces what comes next.
 */
async function newsPastTheMark(environment: CliEnvironment, session: Session, stop: AbortSignal): Promise<DigestNews | undefined> {
  const configDir = configDirOf(environment.env);
  const read = new AbortController();
  const onStop = () => read.abort();
  stop.addEventListener("abort", onStop, { once: true });
  void sleepOf(environment)(PAST_MARK_MS, read.signal).then(() => read.abort());
  try {
    const waited = await waitOnce(environment, session, Math.max(announcedThrough(configDir, session) - 1, 0), read.signal);
    if (waited.kind !== "answered") return undefined;
    const notices = await announceFresh(configDir, session, noticesOf(session.url, waited.entries), waited.cursor);
    // One answer of the wait lists a page of updates at most, as whats_new does: a full one may have more after it.
    return notices === undefined ? undefined : { notices, more: waited.entries.length >= DIGEST_LIMIT };
  } finally {
    read.abort();
    stop.removeEventListener("abort", onStop);
  }
}

/**
 * `tiehall hook session-start`: prints the digest of the updates after the
 * CLI client's cursor that have not been announced, read without
 * acknowledging anything, or nothing; 0 whatever happens.
 */
export async function hookSessionStart(environment: CliEnvironment, install: string | undefined): Promise<number> {
  const stop = new AbortController();
  try {
    await hookInputOf(environment);
    const login = chooseLogin(configDirOf(environment.env), { install });
    const session = sessionFor(environment, login);
    void sleepOf(environment)(DIGEST_READ_MS, stop.signal).then(() => stop.abort());
    const answer = await session.send((client) => client.POST("/api/v1/updates", { body: { limit: DIGEST_LIMIT }, signal: stop.signal }), stop.signal);
    if (!answer.ok) return 0;
    const page = answer.body as { events?: unknown; more?: unknown } | undefined;
    if (!Array.isArray(page?.events)) return 0;
    const entries = (page.events as UpdateEntry[]).map(({ number, type, request }) => ({
      seq: number,
      type,
      request_key: request?.key,
      team_key: request?.targetTeam?.key,
      url: request?.url,
    }));
    const onPage = await announceFresh(configDirOf(environment.env), session, noticesOf(session.url, entries));
    const news: DigestNews | undefined =
      onPage !== undefined ? { notices: onPage, more: page.more === true } : page.more === true ? await newsPastTheMark(environment, session, stop.signal) : undefined;
    if (news === undefined) return 0;
    environment.stdout(sessionDigestOf(news));
    return 0;
  } catch {
    // A session starts whatever happens here, and nothing reaches Claude but the digest.
    return 0;
  } finally {
    stop.abort();
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
    command: "hook session-start",
    summary: "For the Claude Code plugin's SessionStart hook: print the updates on your requests that are new, with their request keys, event types, teams and URLs.",
  },
  {
    command: "hook wait",
    summary:
      "For the Claude Code plugin's Stop hook: wait up to 30 minutes for news on your requests, and exit with code 2, which wakes Claude, with its request keys, event types, teams and URLs.",
  },
  { command: "hook session-end", summary: "For the Claude Code plugin's SessionEnd hook: stop the session's waiter and free its lock." },
];
