import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../lib/run-command.ts";

// The web UI's way to run an operation (public-api: One definition per
// operation, the same on every surface). Until sign-in exists (group 7),
// nobody is signed in, so it runs nothing and answers as /api/v1 answers a
// call without credentials. packages/commands/test/web-commands.test.ts
// tests the path it takes, execute() as the web session, against a database.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runCommand", () => {
  it("runs nothing without a signed-in user, answering with the 401 problem", async () => {
    // Settings that name an app role and a password, never used: nothing reaches the database.
    vi.stubEnv("TIEHALL_DATABASE_APP_URL", "postgres://tiehall_app@127.0.0.1:1/tiehall");
    vi.stubEnv("TIEHALL_DATABASE_APP_PASSWORD", "unused");
    expect(await runCommand("requests.decline", { key: "FE-142" })).toMatchObject({
      ok: false,
      problem: { status: 401, type: "https://tiehall.com/problems/unauthenticated" },
    });
  });
});
