import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/confirm/[command]/route.ts";

// The review pages of the confirmation step (agent-safety: The review page of
// the confirmation step). Until sign-in exists (group 7), nobody is signed in,
// so a review page answers as /api/v1 answers a call without credentials, and
// even that answer cannot be framed. packages/commands/test/review-page.test.ts
// tests the pages themselves against a database.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a review page", () => {
  it("answers 401 without a signed-in user, with a Content-Security-Policy that forbids framing", async () => {
    // Settings that name an app role and a password, never used: nothing reaches the database.
    vi.stubEnv("TIEHALL_URL", "https://tiehall.example.com");
    vi.stubEnv("TIEHALL_DATABASE_APP_URL", "postgres://tiehall_app@127.0.0.1:1/tiehall");
    vi.stubEnv("TIEHALL_DATABASE_APP_PASSWORD", "unused");
    const input = encodeURIComponent(JSON.stringify({ scope: "requests:read" }));
    const response = await GET(new Request(`https://tiehall.example.com/confirm/tokens.create?input=${input}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ type: "https://tiehall.com/problems/unauthenticated" });
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
