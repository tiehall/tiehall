import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCommand } from "../lib/read-command.ts";
import { writeCommand } from "../lib/write-command.ts";

// The web UI's way to run an operation (public-api: One definition per
// operation, the same on every surface; agent-safety: One confirmation
// approves one action): server components read through readCommand() and
// server actions write through writeCommand(), which hands execute() the
// request's Origin and Sec-Fetch-Site and the form's CSRF token. Without a
// session cookie nobody is signed in, so both run nothing and answer as
// /api/v1 answers a call without credentials. The paths they take are tested
// against a database in packages/commands/test/web-commands.test.ts and
// web-writes.test.ts.

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

beforeEach(() => {
  // Settings that name an app role and a password, never used: nothing reaches the database.
  vi.stubEnv("TIEHALL_URL", "https://tiehall.example.com");
  vi.stubEnv("TIEHALL_AUTH_SECRET", "a-secret-of-at-least-thirty-two-characters-for-tests");
  vi.stubEnv("TIEHALL_DATABASE_APP_URL", "postgres://tiehall_app@127.0.0.1:1/tiehall");
  vi.stubEnv("TIEHALL_DATABASE_APP_PASSWORD", "unused");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const unauthenticated = { ok: false, problem: { status: 401, type: "https://tiehall.com/problems/unauthenticated" } };

describe("readCommand", () => {
  it("runs nothing without a signed-in user, answering with the 401 problem", async () => {
    expect(await readCommand("requests.get", { key: "FE-142" })).toMatchObject(unauthenticated);
  });
});

describe("writeCommand", () => {
  it("runs nothing without a signed-in user, answering with the 401 problem", async () => {
    requestHeaders.current = new Headers({ origin: "https://tiehall.example.com", "sec-fetch-site": "same-origin" });
    expect(await writeCommand("requests.decline", { key: "FE-142" }, "a-csrf-token")).toMatchObject(unauthenticated);
  });
});
