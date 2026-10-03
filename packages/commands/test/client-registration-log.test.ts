import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The sign-in service checks the origin of the URLs a request names, and turns that check off under a test runner,
// where NODE_ENV is "test" or TEST is "true"; the web role runs with it on. They are set here before any module
// loads, so the sign-in service below checks as it does in production.
vi.hoisted(() => {
  process.env["NODE_ENV"] = "production";
  process.env["TEST"] = "false";
});

import { startAgentAccess, type AgentAccessHarness } from "./support/agent-access.ts";

// Logs carry ids, never message text or credentials (self-host-install: Logs
// carry ids, never message text or credentials; design.md, Self-hosting
// decisions: S13), so the logger scrubs every string it writes. Some of those
// come from callers who need no account: Dynamic Client Registration is open
// to any agent client (agent-access: Dynamic Client Registration stays on,
// limited and unverified), and the sign-in service logs the callbackURL of a
// registration it refuses, from a body of up to 2 MiB (public-api: Request
// bodies have a size limit). Scrubbing that text takes time in proportion to
// its length, whatever it holds, so one such request cannot hold up every
// other request the process serves.

let harness: AgentAccessHarness;

beforeAll(async () => {
  harness = await startAgentAccess();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const LENGTH = 96 * 1024;

async function register(callbackURL: string): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const answer = await harness.register({ callbackURL }, { "x-forwarded-for": "198.51.100.7" });
  await answer.text();
  return { status: answer.status, ms: performance.now() - started };
}

describe("a client registration whose callbackURL the sign-in service logs", () => {
  it("is answered as fast as a plain one, whatever its callbackURL holds", async () => {
    const plain = await register(`https://elsewhere.example/${"x".repeat(LENGTH)}`);
    // A run of a token's characters with a start of a JWT every four characters and no dot to end it.
    const crafted = await register(`https://elsewhere.example/${"-eyJ".repeat(LENGTH / 4)}`);
    expect(crafted.status).toBe(plain.status);
    expect(crafted.ms).toBeLessThan(plain.ms + 1_000);
  }, 120_000);
});
