import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeState } from "../lib/home.ts";

// The home page (sign-in: GitHub is the only way to sign in): a person who is
// not signed in is sent to the sign-in page, which offers sign-in with GitHub
// only. A browser that carries no session cookie reaches neither the database
// nor the sign-in service. packages/commands/test/sign-in.test.ts tests the
// sign-in service and its sessions against a database.

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

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
    requestHeaders.current = new Headers({ cookie: "other=1" });
    expect(await homeState()).toEqual({ kind: "sign-in" });
  });
});
