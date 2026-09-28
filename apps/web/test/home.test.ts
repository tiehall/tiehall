import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/route.ts";

// The home page (sign-in: GitHub is the only way to sign in): a person who is
// not signed in is sent to the sign-in page, which offers sign-in with GitHub
// only. A browser that carries no session cookie reaches neither the database
// nor the sign-in service. packages/commands/test/home-page.test.ts tests the
// page with sessions against a database.

beforeEach(() => {
  // Settings that name an app role and a password, never used: nothing reaches the database.
  vi.stubEnv("TIEHALL_URL", "https://tiehall.example.com");
  vi.stubEnv("TIEHALL_DATABASE_APP_URL", "postgres://tiehall_app@127.0.0.1:1/tiehall");
  vi.stubEnv("TIEHALL_DATABASE_APP_PASSWORD", "unused");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the home page", () => {
  it("sends a person who is not signed in to the sign-in page", async () => {
    const answer = await GET(new Request("https://tiehall.example.com/", { headers: { cookie: "other=1" } }));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/sign-in");
  });
});
