// The JSON logger (self-host-install: Logs carry ids, never message text or
// credentials; design.md, Self-hosting decisions: S13). Every line it writes
// is one JSON object on standard output: the time, the level, the message and
// the fields. Logs carry ids, never the text of messages or packets and never
// a credential, so before a line is written the logger drops:
// - the values of fields whose names say they hold a credential (tokens,
//   secrets, passwords, nonces, session ids, the Authorization, Cookie and
//   Set-Cookie headers) or a body (text, body, content, packet, title, ...);
// - the query strings and fragments of URLs and paths, and the user info of
//   URLs, in the message and in every field, its name as well as its value;
// - anything shaped like a token Tiehall or an integration issues (personal
//   access tokens, bearer and basic credentials, JWTs, GitHub and Atlassian
//   tokens), wherever it appears;
// - the message of an error, which can quote the data it failed on, unless
//   Tiehall wrote that error to be logged: an error is logged by its name, its
//   code, its stack frames and its cause. An error spread into a plain object,
//   with a message and a stack, is treated the same way.
// Each string a line holds, the message, every value and every field's name,
// is then cut to 2 KiB, with how many characters were cut, since a string can
// be as long as a body a caller sends; and two names that scrub to the same
// name each keep their value, the later ones under a numbered name.
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

/** How many characters of a string a log line keeps, once the string is scrubbed: 2 KiB. */
export const LOGGED_STRING_MAX = 2_048;

/** A string as a log line holds it: scrubbed, then cut to LOGGED_STRING_MAX characters, saying how many were cut. */
function logged(text: string): string {
  const clean = scrub(text);
  return clean.length <= LOGGED_STRING_MAX ? clean : `${clean.slice(0, LOGGED_STRING_MAX)}… [${clean.length - LOGGED_STRING_MAX} more characters]`;
}

export function createLogger(options: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const line = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    const entry = { ...sanitizeFields({ ...bindings, ...fields }), time: now().toISOString(), level, msg: logged(msg) };
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
  if (typeof value === "string") return logged(value);
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
        result[key] = stackFrames(item, (value as { message?: unknown }).message);
        continue;
      }
      const clean = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
      // A name can hold what a value can, such as a token a cache is keyed by, or a URL; two names that scrub to the
      // same name each keep their value, the later ones under a numbered name.
      if (clean !== undefined) result[unusedName(result, logged(key))] = clean;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** The name, or, when the object has it already, the name with the first number from 2 on that it does not have. */
function unusedName(object: Readonly<Record<string, unknown>>, name: string): string {
  if (!Object.hasOwn(object, name)) return name;
  let number = 2;
  while (Object.hasOwn(object, `${name} (${number})`)) number += 1;
  return `${name} (${number})`;
}

function isErrorLike(value: object): boolean {
  const { message, stack } = value as { message?: unknown; stack?: unknown };
  return typeof message === "string" && typeof stack === "string";
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = { name: logged(error.name) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") result["code"] = logged(String(code));
  if ((error as { [LOGGABLE]?: unknown })[LOGGABLE] === true) result["message"] = logged(error.message);
  result["stack"] = stackFrames(error.stack, error.message);
  if (error.cause !== undefined) result["cause"] = sanitize(error.cause, depth + 1, seen);
  if (error instanceof AggregateError) result["errors"] = sanitize(error.errors, depth + 1, seen);
  return result;
}

/**
 * The frames of an error's stack, its indented "at ..." lines. The stack starts with the error's name and message,
 * whose lines can read like frames, so the message is cut off first when it starts on the stack's first line, as V8
 * writes it. A line of a message that was changed after the stack was written is left out too, unless it is
 * indented as V8 indents frames.
 */
function stackFrames(stack: unknown, message: unknown): string[] {
  let frames = typeof stack === "string" ? stack : "";
  if (typeof message === "string" && message !== "") {
    const at = frames.indexOf(message);
    if (at !== -1 && !frames.slice(0, at).includes("\n")) frames = frames.slice(at + message.length);
  }
  return frames
    .split("\n")
    .filter((frame) => /^\s+at \S/.test(frame))
    .slice(0, 20)
    .map((frame) => logged(frame.trim()));
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
 * those words runs on through the credential after it. HTTP compares the names
 * of its authentication schemes in any case, and so does the logger.
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
  /\b(?:bearer|basic)(?:\s+[A-Za-z0-9._~+/=-]*?\b(?:bearer|basic)(?=\s))*\s+[A-Za-z0-9._~+/=-]+/gi,
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
/** The authority of a URL, its user info, `@` and host, runs up to `/`, `?`, `#` or whitespace: `[^/\s?#]`. */
const isAuthorityCharacter = (code: number) => code !== 47 && code !== 63 && code !== 35 && !isSpace(code);
/** A query string or a fragment runs up to whitespace, a quote, `<` or `>`: `[^\s"'<>]`. */
const isQueryCharacter = (code: number) => code !== 34 && code !== 39 && code !== 60 && code !== 62 && !isSpace(code);
/** A URL or a path runs up to its query string or fragment, and stops where those stop: `[^\s?#"'<>]`. */
const isPathCharacter = (code: number) => code !== 63 && code !== 35 && isQueryCharacter(code);
/**
 * What a path may follow: anything but a letter, a digit, `_` or `-`, which end the names before a slash that is
 * not a path's, as in the issue reference acme/web#142.
 */
const leadsPath = (code: number) => !isWordCharacter(code) && code !== 45;

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
 * Reads the run of a scheme's characters that starts at `from`, and says where it ends, whether a scheme, a letter
 * and what follows it, ends there: `[a-z][a-z0-9+.-]*`, and whether it holds a dot, as a host name does. A scheme
 * is found wherever its letter is, so one glued to a word, as in DATABASE_URL_postgres://, is found too. Every
 * scheme or host name that starts in a run ends where the run ends, because no scheme character can begin `://`,
 * `/` or a port.
 */
function schemeRun(text: string, from: number): { end: number; scheme: boolean; dotted: boolean } {
  let scheme = false;
  let dotted = false;
  let end = from;
  for (; end < text.length && isSchemeCharacter(text.charCodeAt(end)); end += 1) {
    if (isLetter(text.charCodeAt(end))) scheme = true;
    if (text.charCodeAt(end) === 46) dotted = true;
  }
  return { end, scheme, dotted };
}

/**
 * Whether a path follows a host name that ends at `at`, without the URL's scheme: a slash after a name with a dot,
 * as in tiehall.example.com/api, or a port and a slash, as in localhost:3000/api.
 */
function pathFollowsHost(text: string, at: number, dotted: boolean): boolean {
  if (text.charCodeAt(at) === 47) return dotted;
  if (text.charCodeAt(at) !== 58) return false;
  const port = runEnd(text, at + 1, isDigit);
  return port > at + 1 && text.charCodeAt(port) === 47;
}

/**
 * The text with the user info of each URL replaced, such as the password in postgres://user:password@host:
 * `([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@`. The user info ends at the authority's last `@`, as URL parsers end it, so
 * a password that holds an unencoded `@` is replaced whole.
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
    let to = runEnd(text, from, isAuthorityCharacter) - 1;
    while (to >= from && text.charCodeAt(to) !== 64) to -= 1;
    if (to < from) continue;
    result += text.slice(kept, from) + REDACTED;
    kept = to;
    at = to + 1;
  }
  return result + text.slice(kept);
}

/**
 * The query strings and fragments of URLs, with or without their scheme, and of paths, as the spans they cover: a
 * URL, `[a-z][a-z0-9+.-]*:\/\/`, a host name and the path after it, or a path, `/` at the start or after what
 * `leadsPath` names, then `[^\s?#"'<>]*` before `[?#][^\s"'<>]*`. A URL or a path that starts anywhere in a run of
 * its characters ends where the run ends, so each run is read once.
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
        starts = (run.scheme && text.startsWith("://", run.end)) || pathFollowsHost(text, run.end, run.dotted);
        end = run.end;
      } else {
        end += 1;
      }
    }
    at = end;
    const mark = text.charCodeAt(end);
    if (!starts || (mark !== 63 && mark !== 35)) continue;
    at = runEnd(text, end + 1, isQueryCharacter);
    spans.push({ from: end, to: givesBackClosers(text, end, at) });
  }
  return spans;
}

/** The brackets a query string's run can end with, each with the bracket that opens it, and the other way round. */
const OPENERS: Readonly<Record<number, number>> = { 41: 40, 93: 91, 125: 123 };
const CLOSERS: Readonly<Record<number, number>> = { 40: 41, 91: 93, 123: 125 };

/**
 * Where a query string that runs from `from` to `to` ends once it gives back the closing brackets it ends with but
 * does not open itself, as in "(see https://x.example/a?b=c)", so dropping it leaves the bracket that closes what
 * came before it. The brackets of the run are counted once, so the time grows only with its length.
 */
function givesBackClosers(text: string, from: number, to: number): number {
  // For each kind of bracket, by its closer: how many the run opens, less how many it closes.
  const open = new Map<number, number>();
  for (let at = from; at < to; at += 1) {
    const code = text.charCodeAt(at);
    const closes = OPENERS[code] !== undefined ? code : undefined;
    const opens = CLOSERS[code];
    if (closes !== undefined) open.set(closes, (open.get(closes) ?? 0) - 1);
    if (opens !== undefined) open.set(opens, (open.get(opens) ?? 0) + 1);
  }
  let end = to;
  while (end - 1 > from) {
    const closer = text.charCodeAt(end - 1);
    if (OPENERS[closer] === undefined || (open.get(closer) ?? 0) >= 0) return end;
    // Given back, the bracket no longer counts against the run.
    open.set(closer, (open.get(closer) ?? 0) + 1);
    end -= 1;
  }
  return end;
}

/**
 * JWTs, as the spans they cover: `\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_.-]*`. The second part may be
 * empty, as a JWE's encrypted key is with direct encryption. A JWT that starts anywhere in a run of its first part's
 * characters has its first part end where the run ends, so each run is read once, and the first JWT in it covers
 * every later one.
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
    if (text.charCodeAt(second) !== 46) continue;
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
