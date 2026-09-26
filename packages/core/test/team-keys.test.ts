import { describe, expect, it } from "vitest";
import { isTeamKey } from "../src/index.ts";

// Team keys (teams-and-roles: Team keys; design.md, Self-hosting decisions:
// S15). A key has 2 to 10 characters, the uppercase letters A to Z and the
// digits 0 to 9, and starts with a letter. Every app path is lowercase, so a
// key never shadows one.

describe("a team key", () => {
  it.each(["FE", "PAY2", "PLATFORM10", "MCP", "API", "A1", "ZZZZZZZZZZ"])("may be %s", (key) => {
    expect(isTeamKey(key)).toBe(true);
  });

  it.each(["fe", "Fe", "F", "2FE", "2FA", "PLATFORM100", "FE-X", "FE_X", "FE X", " FE", "FÉ", "", "ÄB"])("may not be %j", (key) => {
    expect(isTeamKey(key)).toBe(false);
  });

  it.each(["api", "mcp", "docs", "confirm", "setup", "webhooks", "schemas", ".well-known", "healthz"])(
    "is never the app path /%s, which is lowercase",
    (segment) => {
      expect(isTeamKey(segment)).toBe(false);
    },
  );
});
