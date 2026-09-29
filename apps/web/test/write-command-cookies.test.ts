import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeCommand } from "../lib/write-command.ts";

// A server action passes on the cookie that renews the web session its write
// read (sign-in: Signing out and ending sessions; github-layer-hardening:
// design.md, Technical decisions: T4): the read gives the Set-Cookie values
// the sign-in service made, and the action sets each through Next.js's
// cookies(), by its parts, as a route handler's answer carries them. The read
// that renews the session is tested against a database in
// packages/commands/test/session-lengths.test.ts; here the operations are
// stubbed, so nothing reaches the database.

const state = vi.hoisted(() => ({ renewing: [] as string[], set: [] as unknown[] }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://tiehall.example.com", "sec-fetch-site": "same-origin" }),
  cookies: async () => ({ set: (cookie: unknown) => void state.set.push(cookie) }),
}));

vi.mock("@tiehall/commands/web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiehall/commands/web")>();
  return {
    ...actual,
    webCommands: () => ({
      async write(_commandId: string, _input: unknown, _request: unknown, options: { renewal?: Headers } = {}) {
        for (const line of state.renewing) options.renewal?.append("set-cookie", line);
        return { ok: true, output: {} };
      },
    }),
  };
});

beforeEach(() => {
  state.renewing = [];
  state.set = [];
});

describe("writeCommand", () => {
  it("sets the cookie that renews the session its write read, by its parts", async () => {
    state.renewing = ["__Secure-tiehall.session_token=a1b2%2Bc3.d4%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax"];

    expect(await writeCommand("users.set_bot_flag", { userId: "u", bot: false }, "a-csrf-token")).toEqual({ ok: true, output: {} });

    expect(state.set).toEqual([
      { name: "__Secure-tiehall.session_token", value: "a1b2+c3.d4=", maxAge: 604800, path: "/", httpOnly: true, secure: true, sameSite: "lax" },
    ]);
  });

  it("sets no cookie when the read renewed nothing", async () => {
    expect(await writeCommand("users.set_bot_flag", { userId: "u", bot: false }, "a-csrf-token")).toEqual({ ok: true, output: {} });
    expect(state.set).toEqual([]);
  });
});
