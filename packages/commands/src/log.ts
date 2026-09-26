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
// setup screen's task prints in a message (self-host-install: setup code).

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

/** Token shapes, anywhere in a string. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bth_pat_[A-Za-z0-9_-]+/g,
  /\b(?:Bearer|bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bATATT[A-Za-z0-9_=-]{16,}/g,
];

/** The user info of a URL, such as the password in postgres://user:password@host. */
const USER_INFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]*@/gi;

/** A URL, or a path after a space, a quote or the start, with its query string or fragment. */
const QUERY = /((?:\b[a-z][a-z0-9+.-]*:\/\/|(?<=^|[\s"'(=])\/)[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

/** A string with every credential shape, user info, query string and fragment removed. */
export function scrub(text: string): string {
  let clean = text.replace(USER_INFO, `$1${REDACTED}@`).replace(QUERY, "$1");
  for (const pattern of TOKEN_PATTERNS) clean = clean.replace(pattern, REDACTED);
  return clean;
}
