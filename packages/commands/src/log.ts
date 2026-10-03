// The JSON logger (self-host-install: Logs carry ids, never message text or
// credentials; design.md, Self-hosting decisions: S13). Every line it writes
// is one JSON object on standard output: the time, the level, the message and
// the fields. Logs carry ids, never the text of messages or packets and never
// a credential, so before a line is written the logger drops:
// - the values of fields whose names say they hold a credential (tokens,
//   secrets, passwords, nonces, session ids, the Authorization, Cookie and
//   Set-Cookie headers) or a body (text, body, content, packet, title, ...);
// - the query strings and fragments of URLs and paths, and the user info of
//   URLs, in the message and in every field;
// - anything shaped like a token Tiehall or an integration issues (personal
//   access tokens, bearer and basic credentials, JWTs, GitHub and Atlassian
//   tokens), wherever it appears;
// - the message of an error, which can quote the data it failed on, unless
//   Tiehall wrote that error to be logged: an error is logged by its name, its
//   code, its stack frames and its cause. An error spread into a plain object,
//   with a message and a stack, is treated the same way.
// The one secret a log line shows on purpose is the setup code, which the
// setup screen's task prints in a message (self-host-install: Logs carry ids,
// never message text or credentials).
// What a library prints to the console, such as the Next.js server that the
// web role loads, can be sent through a logger with routeConsoleTo(), so that
// it too is JSON on standard output and passes the same redaction.

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

/** One parsed log line. */
export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Where each line goes; standard output unless a test captures it. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Marks an error whose message Tiehall wrote from server text alone, such as a
 * refusal that names a setting or a migration, so the logger keeps it.
 */
export const LOGGABLE: unique symbol = Symbol.for("tiehall.loggable");

export const REDACTED = "[redacted]";

export function createLogger(options: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const line = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    const entry = { ...sanitizeFields({ ...bindings, ...fields }), time: now().toISOString(), level, msg: scrub(msg) };
    // time, level and msg lead the line, and no field can replace them.
    const { time, level: lineLevel, msg: message, ...rest } = entry;
    write(JSON.stringify({ time, level: lineLevel, msg: message, ...rest }));
  };
  return {
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
    child: (fields) => createLogger({ write, now }, { ...bindings, ...fields }),
  };
}

/** The console methods libraries print with, and the level each one logs at. */
const CONSOLE_LEVELS = {
  log: "info",
  info: "info",
  debug: "info",
  dir: "info",
  warn: "warn",
  error: "error",
  trace: "error",
} as const satisfies Record<string, LogLevel>;

/** Colors and other ANSI escape sequences that libraries print for a terminal. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Sends every call of the console's printing methods through the logger, as
 * one JSON line at the level of the method, with the field `via: "console"`:
 * the printed strings, without colors, form the message; a printed error is
 * logged as an error is, by its name, code and stack frames, never its
 * message; other printed values go under `values`, redacted as fields are. A
 * call that prints only blank strings writes no line. Returns a function that
 * gives the console back as it was.
 */
export function routeConsoleTo(logger: Logger, target: Console = console): () => void {
  const printing = logger.child({ via: "console" });
  const originals = new Map<keyof typeof CONSOLE_LEVELS, unknown>();
  for (const [method, level] of Object.entries(CONSOLE_LEVELS) as [keyof typeof CONSOLE_LEVELS, LogLevel][]) {
    originals.set(method, target[method]);
    target[method] = (...args: unknown[]) => {
      const line = consoleLine(args);
      if (line !== undefined) printing[level](line.msg, line.fields);
    };
  }
  return () => {
    for (const [method, original] of originals) (target as unknown as Record<string, unknown>)[method] = original;
  };
}

function consoleLine(args: readonly unknown[]): { msg: string; fields: Record<string, unknown> } | undefined {
  const words: string[] = [];
  const errors: unknown[] = [];
  const values: unknown[] = [];
  for (const arg of args) {
    if (typeof arg === "string") words.push(arg.replace(ANSI, ""));
    else if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") words.push(String(arg));
    else if (arg instanceof Error || (typeof arg === "object" && arg !== null && isErrorLike(arg))) errors.push(arg);
    else if (arg !== undefined) values.push(arg);
  }
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  if (text === "" && errors.length === 0 && values.length === 0) return undefined;
  const fields: Record<string, unknown> = {};
  if (errors.length === 1) fields["error"] = errors[0];
  else if (errors.length > 1) fields["errors"] = errors;
  if (values.length > 0) fields["values"] = values;
  const msg = text !== "" ? text : errors.length > 0 ? "an error was printed to the console" : "a value was printed to the console";
  return { msg, fields };
}

/** Words that, as a whole word of a field's name, say it holds content someone wrote. */
const BODY_WORDS = new Set(["body", "text", "content", "contents", "packet", "title", "description", "comment", "markdown", "html"]);

/** Parts that, anywhere in a field's name without its separators, say it holds a credential. */
const CREDENTIAL_PARTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "nonce",
  "session",
  "signature",
];

const MAX_DEPTH = 8;
const MAX_ITEMS = 50;

function sanitizeFields(fields: LogFields): Record<string, unknown> {
  return sanitize(fields, 0, new WeakSet()) as Record<string, unknown>;
}

function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (CREDENTIAL_PARTS.some((part) => flat.includes(part))) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => BODY_WORDS.has(word));
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return scrub(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  try {
    if (value instanceof Error) return sanitizeError(value, depth, seen);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1, seen));
      return value.length > MAX_ITEMS ? [...items, `[${value.length - MAX_ITEMS} more]`] : items;
    }
    const entries = value instanceof Map ? [...value.entries()].map(([key, item]) => [String(key), item] as const) : Object.entries(value);
    const result: Record<string, unknown> = {};
    // An error spread into a plain object, as some libraries report errors: its message is left out as an
    // error's is, and its stack, whose first line repeats the message, is kept as frames only.
    const errorLike = isErrorLike(value);
    if (errorLike && !("name" in value)) {
      // The class name leads the stack's first line, before the message, as in "TypeError: ...".
      result["name"] = /^([A-Za-z_$][\w$]*)(?::|$)/.exec((value as { stack: string }).stack)?.[1] ?? "Error";
    }
    for (const [key, item] of entries) {
      if (errorLike && key === "message") continue;
      if (errorLike && key === "stack") {
        result[key] = stackFrames({ stack: item as string } as Error);
        continue;
      }
      const clean = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function isErrorLike(value: object): boolean {
  const { message, stack } = value as { message?: unknown; stack?: unknown };
  return typeof message === "string" && typeof stack === "string";
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = { name: scrub(error.name) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") result["code"] = scrub(String(code));
  if ((error as { [LOGGABLE]?: unknown })[LOGGABLE] === true) result["message"] = scrub(error.message);
  result["stack"] = stackFrames(error);
  if (error.cause !== undefined) result["cause"] = sanitize(error.cause, depth + 1, seen);
  if (error instanceof AggregateError) result["errors"] = sanitize(error.errors, depth + 1, seen);
  return result;
}

/** The "at ..." lines of an error's stack, without the first lines, which repeat its message. */
function stackFrames(error: Error): string[] {
  return (error.stack ?? "")
    .split("\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("at "))
    .slice(0, 20)
    .map(scrub);
}

/**
 * Token shapes, anywhere in a string. A GitHub token is found by its prefix
 * alone and dropped whole, whatever follows it: GitHub's installation tokens
 * are moving to a format of about 520 characters with `_`, `-` and `.` after
 * the prefix, so no length and no alphabet of letters and digits is assumed
 * (github-app-reachability: design.md, Design rules: Installation tokens).
 *
 * A long token can hold the start of another shape, such as `-eyJ` and two
 * dots, which make a JWT inside an installation token. So scrub() matches every
 * shape in the same string and redacts all that they match together: no shape
 * can cut another's match short and leave its tail in the log. Each shape also
 * ends where a match of it that begins inside it would end, so one scan of a
 * shape finds all it covers: a JWT runs on through every part after its third,
 * as a JWE has five, and a Bearer or Basic credential that ends with one of
 * those words runs on through the credential after it.
 *
 * The logger scrubs text that callers who need no account can send, in bodies
 * of up to 2 MiB, so a scrub takes time in proportion to the text's length,
 * whatever the text. Each pattern here fails within a few characters of where
 * it starts, or matches everything it reads, so no character is read again
 * from each place a match could start. The shapes that would read a long run
 * of characters and then fail, a JWT, the user info of a URL and a query
 * string, are found by the scans below them instead, which read each run once.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bth_pat_[A-Za-z0-9_-]+/g,
  /\b(?:Bearer|bearer|Basic)(?:\s+[A-Za-z0-9._~+/=-]*?\b(?:Bearer|bearer|Basic)(?=\s))*\s+[A-Za-z0-9._~+/=-]+/g,
  /\bgh[pousr]_[A-Za-z0-9_.-]+/g,
  /\bgithub_pat_[A-Za-z0-9_.-]+/g,
  /\bATATT[A-Za-z0-9_=-]{16,}/g,
];

/** The characters a scan reads, by their UTF-16 code, as the patterns' classes have them. */
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isDigit = (code: number) => code >= 48 && code <= 57;
/** A character of `\w`, which `\b` sets apart from the others. */
const isWordCharacter = (code: number) => isLetter(code) || isDigit(code) || code === 95;
/** `\s`: whitespace and line terminators. */
const isSpace = (code: number) =>
  (code >= 9 && code <= 13) ||
  code === 32 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;
/** A URL scheme's characters: `[a-z0-9+.-]`, in either case. */
const isSchemeCharacter = (code: number) => isLetter(code) || isDigit(code) || code === 43 || code === 45 || code === 46;
/** The characters of a JWT's first two parts, `[A-Za-z0-9_-]`, and of its third and later parts, with `.`. */
const isJwtCharacter = (code: number) => isWordCharacter(code) || code === 45;
const isJwtTailCharacter = (code: number) => isJwtCharacter(code) || code === 46;
/** The user info of a URL runs up to `@`, and stops at `/`, `?`, `#` and whitespace: `[^/\s@?#]`. */
const isUserInfoCharacter = (code: number) => code !== 47 && code !== 64 && code !== 63 && code !== 35 && !isSpace(code);
/** A query string or a fragment runs up to whitespace, a quote, `<` or `>`: `[^\s"'<>]`. */
const isQueryCharacter = (code: number) => code !== 34 && code !== 39 && code !== 60 && code !== 62 && !isSpace(code);
/** A URL or a path runs up to its query string or fragment, and stops where those stop: `[^\s?#"'<>]`. */
const isPathCharacter = (code: number) => code !== 63 && code !== 35 && isQueryCharacter(code);
/** What a path may follow: whitespace, a quote, `(` or `=`. */
const leadsPath = (code: number) => isSpace(code) || code === 34 || code === 39 || code === 40 || code === 61;

/** Where the run of characters of this class that starts at `from` ends. */
function runEnd(text: string, from: number, inRun: (code: number) => boolean): number {
  let end = from;
  while (end < text.length && inRun(text.charCodeAt(end))) end += 1;
  return end;
}

/** Whether `\b` holds before a word character at `at`. */
function startsWord(text: string, at: number): boolean {
  return at === 0 || !isWordCharacter(text.charCodeAt(at - 1));
}

/**
 * Reads the run of a scheme's characters that starts at `from`, and says where it ends and whether a scheme, a
 * letter at the start of a word and what follows it, ends there: `\b[a-z][a-z0-9+.-]*`. Every scheme that starts
 * in a run ends where the run ends, because no scheme character can begin `://`.
 */
function schemeRun(text: string, from: number): { end: number; scheme: boolean } {
  let scheme = false;
  let end = from;
  for (; end < text.length && isSchemeCharacter(text.charCodeAt(end)); end += 1) {
    if (!scheme && isLetter(text.charCodeAt(end)) && startsWord(text, end)) scheme = true;
  }
  return { end, scheme };
}

/**
 * The text with the user info of each URL replaced, such as the password in postgres://user:password@host:
 * `\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]*@`.
 */
function withoutUserInfo(text: string): string {
  let result = "";
  let kept = 0;
  let at = 0;
  while (at < text.length) {
    if (!isSchemeCharacter(text.charCodeAt(at))) {
      at += 1;
      continue;
    }
    const { end, scheme } = schemeRun(text, at);
    at = end;
    if (!scheme || !text.startsWith("://", end)) continue;
    const from = end + 3;
    const to = runEnd(text, from, isUserInfoCharacter);
    if (text.charCodeAt(to) !== 64) continue;
    result += text.slice(kept, from) + REDACTED;
    kept = to;
    at = to + 1;
  }
  return result + text.slice(kept);
}

/**
 * The query strings and fragments of URLs, and of paths after a space, a quote, `(`, `=` or the start, as the
 * spans they cover: `(?:\b[a-z][a-z0-9+.-]*:\/\/|(?<=^|[\s"'(=])\/)[^\s?#"'<>]*` before `[?#][^\s"'<>]*`. A URL or
 * a path that starts anywhere in a run of its characters ends where the run ends, so each run is read once.
 */
function queryStrings(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let at = 0;
  while (at < text.length) {
    if (!isPathCharacter(text.charCodeAt(at))) {
      at += 1;
      continue;
    }
    let starts = false;
    let end = at;
    while (end < text.length && isPathCharacter(text.charCodeAt(end))) {
      const code = text.charCodeAt(end);
      if (!starts && code === 47 && (end === 0 || leadsPath(text.charCodeAt(end - 1)))) {
        starts = true;
        end += 1;
      } else if (!starts && isSchemeCharacter(code)) {
        const run = schemeRun(text, end);
        starts = run.scheme && text.startsWith("://", run.end);
        end = run.end;
      } else {
        end += 1;
      }
    }
    at = end;
    const mark = text.charCodeAt(end);
    if (!starts || (mark !== 63 && mark !== 35)) continue;
    at = runEnd(text, end + 1, isQueryCharacter);
    spans.push({ from: end, to: at });
  }
  return spans;
}

/**
 * JWTs, as the spans they cover: `\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]*`. A JWT that starts
 * anywhere in a run of its first part's characters has its first part end where the run ends, so each run is read
 * once, and the first JWT in it covers every later one.
 */
function jwts(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let at = 0;
  while (at < text.length) {
    if (!isJwtCharacter(text.charCodeAt(at))) {
      at += 1;
      continue;
    }
    let from = -1;
    let first = at;
    for (; first < text.length && isJwtCharacter(text.charCodeAt(first)); first += 1) {
      if (from === -1 && text.startsWith("eyJ", first) && startsWord(text, first)) from = first;
    }
    at = first;
    if (from === -1 || first - (from + 3) < 4 || text.charCodeAt(first) !== 46) continue;
    const second = runEnd(text, first + 1, isJwtCharacter);
    if (second - (first + 1) < 4 || text.charCodeAt(second) !== 46) continue;
    at = runEnd(text, second + 1, isJwtTailCharacter);
    spans.push({ from, to: at });
  }
  return spans;
}

/** A string with every credential shape, user info, query string and fragment removed. */
export function scrub(text: string): string {
  // User info goes first, so that a quote in a password cannot hide the query string after it. It cannot cut a
  // token: it lies between `://` and `@`, and no token shape holds `:` or `@`.
  const clean = withoutUserInfo(text);
  // Every other shape is found in this same string: a query string or a fragment is dropped, a token redacted.
  const spans: { from: number; to: number; query: boolean }[] = [];
  for (const span of queryStrings(clean)) spans.push({ ...span, query: true });
  for (const span of jwts(clean)) spans.push({ ...span, query: false });
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of clean.matchAll(pattern)) spans.push({ from: match.index, to: match.index + match[0].length, query: false });
  }
  if (spans.length === 0) return clean;
  const dropped = new Uint8Array(clean.length);
  const redacted = new Uint8Array(clean.length);
  for (const { from, to, query } of spans) (query ? dropped : redacted).fill(1, from, to);
  // Each run of marked characters becomes one [redacted], or nothing when every token in it lies within a query
  // string or a fragment, which goes without a trace.
  let result = "";
  let kept = 0;
  for (let start = 0; start < clean.length; start += 1) {
    if (dropped[start] === 0 && redacted[start] === 0) continue;
    let end = start;
    let redact = false;
    for (; end < clean.length && (dropped[end] === 1 || redacted[end] === 1); end += 1) {
      if (dropped[end] === 0) redact = true;
    }
    result += clean.slice(kept, start) + (redact ? REDACTED : "");
    kept = end;
    start = end;
  }
  return result + clean.slice(kept);
}
