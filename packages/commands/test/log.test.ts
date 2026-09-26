import { describe, expect, it } from "vitest";
import { createLogger, LOGGABLE, type LogEntry } from "../src/index.ts";

// Logs carry ids, never message text or credentials (self-host-install: Logs
// carry ids, never message text or credentials; design.md, Self-hosting
// decisions: S13). Every line is one JSON object on standard output. The
// logger drops credentials wherever they appear: under keys that name them,
// in Authorization and Cookie headers, in URLs' query strings and user info,
// and in the shapes Tiehall's and its integrations' tokens have. An error is
// logged by its name, code and stack frames, not its message, which can quote
// the data it failed on.

const CANARY_TEXT = "Which endpoint does the export use? canary-7f3a";
const CANARY_PAT = "th_pat_canary7f3a0000000000000000000000";

function capture(): { lines: string[]; entries: () => LogEntry[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => new Date("2026-10-01T12:00:00.000Z") });
  return { lines, entries: () => lines.map((line) => JSON.parse(line) as LogEntry), logger };
}

describe("a log line", () => {
  it("is one JSON object with the time, the level and the message, then the fields", () => {
    const { lines, logger } = capture();
    logger.info("worker: started, working 1 queue", { queues: 1 });
    logger.child({ role: "worker" }).error("worker: job failed", { jobId: "b5a8d2d6-2f0a-4b8f-9d1e-3c4b5a6d7e8f" });
    expect(lines).toEqual([
      '{"time":"2026-10-01T12:00:00.000Z","level":"info","msg":"worker: started, working 1 queue","queues":1}',
      '{"time":"2026-10-01T12:00:00.000Z","level":"error","msg":"worker: job failed","role":"worker","jobId":"b5a8d2d6-2f0a-4b8f-9d1e-3c4b5a6d7e8f"}',
    ]);
  });

  it("keeps a field from replacing the time, the level or the message", () => {
    const { entries, logger } = capture();
    logger.warn("job queue: warning", { time: "then", level: "debug", msg: "other" });
    expect(entries()).toEqual([{ time: "2026-10-01T12:00:00.000Z", level: "warn", msg: "job queue: warning" }]);
  });
});

describe("redaction", () => {
  it("drops the values of keys that name credentials, and the Authorization and Cookie headers", () => {
    const { lines, entries, logger } = capture();
    logger.error("request failed", {
      headers: {
        Authorization: `Bearer ${CANARY_PAT}`,
        cookie: "better-auth.session_token=canary-session",
        "Set-Cookie": "session=canary",
        "Proxy-Authorization": "Basic Y2FuYXJ5",
        "x-api-key": "canary-api-key",
        accept: "application/json",
      },
      password: "canary-password",
      clientSecret: "canary-client-secret",
      refresh_token: "canary-refresh",
      privateKey: "canary-private-key",
      confirmationNonce: "canary-nonce",
      requestId: "FE-142",
    });
    expect(entries()[0]).toMatchObject({
      headers: {
        Authorization: "[redacted]",
        cookie: "[redacted]",
        "Set-Cookie": "[redacted]",
        "Proxy-Authorization": "[redacted]",
        "x-api-key": "[redacted]",
        accept: "application/json",
      },
      password: "[redacted]",
      clientSecret: "[redacted]",
      refresh_token: "[redacted]",
      privateKey: "[redacted]",
      confirmationNonce: "[redacted]",
      requestId: "FE-142",
    });
    expect(lines.join("\n")).not.toMatch(/canary/);
  });

  it("drops query strings and user info from URLs and paths, in fields and in the message", () => {
    const { lines, entries, logger } = capture();
    logger.info("GET /api/v1/requests?token=canary answered 500; retried https://ci:canary@api.github.com/app?code=canary#x", {
      url: "https://tiehall.example.com/api/v1/requests/FE-142?token=canary&state=canary",
      path: "/oauth2/callback?code=canary",
      database: "postgres://tiehall:canary@postgres:5432/tiehall?sslmode=require",
    });
    expect(entries()[0]).toMatchObject({
      msg: "GET /api/v1/requests answered 500; retried https://[redacted]@api.github.com/app",
      url: "https://tiehall.example.com/api/v1/requests/FE-142",
      path: "/oauth2/callback",
      database: "postgres://[redacted]@postgres:5432/tiehall",
    });
    expect(lines.join("\n")).not.toMatch(/canary/);
  });

  it("drops tokens by their shape wherever they appear", () => {
    const { lines, logger } = capture();
    // Joined here, so the secret scan does not take the source for a real token.
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJjYW5hcnkifQ", "c2lnbmF0dXJlY2FuYXJ5"].join(".");
    logger.warn(`retrying with ${CANARY_PAT} and Bearer ${jwt}`, {
      note: `tokens ghs_canary0123456789abcdefghij and github_pat_canary_0123456789abcdefghij`,
      jira: "ATATT3xFfGF0canary0123456789abcdefghijklmnop",
      pieces: [jwt, { nested: { deeper: CANARY_PAT } }],
    });
    expect(lines.join("\n")).not.toMatch(/canary|eyJ/);
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("never logs a body field, such as a message's text", () => {
    const { lines, entries, logger } = capture();
    logger.info("message stored", {
      messageId: "6f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d6e",
      text: CANARY_TEXT,
      body: CANARY_TEXT,
      packet: { need: CANARY_TEXT },
      messageText: CANARY_TEXT,
      context: "the context field is kept",
    });
    expect(entries()[0]).toMatchObject({
      messageId: "6f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d6e",
      text: "[redacted]",
      body: "[redacted]",
      packet: "[redacted]",
      messageText: "[redacted]",
      context: "the context field is kept",
    });
    expect(lines.join("\n")).not.toContain("canary");
  });

  it("logs an error by its name, code and stack frames, never its message, unless Tiehall wrote it to be logged", () => {
    const { lines, entries, logger } = capture();
    const cause = Object.assign(new Error(`upstream refused ${CANARY_TEXT}`), { code: "ECONNRESET" });
    const failure = new TypeError(`posting ${CANARY_TEXT} with ${CANARY_PAT} failed`, { cause });
    const known = Object.assign(new Error("The job queue's schema is missing."), { [LOGGABLE]: true });
    logger.error("worker: job failed", { error: failure, known, bytes: Buffer.from(CANARY_TEXT) });
    const [entry] = entries();
    expect(entry?.["error"]).toEqual({
      name: "TypeError",
      stack: expect.arrayContaining([expect.stringMatching(/^at .*log\.test\.ts:\d+:\d+\)?$/)]),
      cause: { name: "Error", code: "ECONNRESET", stack: expect.any(Array) },
    });
    expect(entry?.["known"]).toMatchObject({ name: "Error", message: "The job queue's schema is missing." });
    expect(entry?.["bytes"]).toBe(`[${Buffer.byteLength(CANARY_TEXT)} bytes]`);
    expect(lines.join("\n")).not.toContain("canary");
  });

  it("treats an error spread into a plain object, as pg-boss reports some, like an error", () => {
    const { lines, entries, logger } = capture();
    const original = new Error(`insert failed for ${CANARY_TEXT}`);
    logger.error("job queue: error", { error: { ...original, message: original.message, stack: original.stack, queue: "mirror.v1" } });
    expect(entries()[0]?.["error"]).toEqual({
      name: "Error",
      stack: expect.arrayContaining([expect.stringMatching(/^at /)]),
      queue: "mirror.v1",
    });
    expect(lines.join("\n")).not.toContain("canary");
  });

  it("survives circular and deep values", () => {
    const { entries, logger } = capture();
    const loop: Record<string, unknown> = { id: "a" };
    loop["self"] = loop;
    let deep: Record<string, unknown> = { id: "bottom" };
    for (let level = 0; level < 20; level++) deep = { next: deep };
    logger.info("shapes", { loop, deep, big: 10n });
    const [entry] = entries();
    expect(entry?.["loop"]).toEqual({ id: "a", self: "[circular]" });
    expect(JSON.stringify(entry?.["deep"])).toContain("[truncated]");
    expect(entry?.["big"]).toBe("10");
  });
});
