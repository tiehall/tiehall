import { describe, expect, it } from "vitest";
import { parseRole, ROLES, usage } from "../src/roles.ts";

// One entrypoint selects the role (design.md, Technical decisions: T1).

describe("parseRole", () => {
  it("knows exactly the four roles", () => {
    expect(ROLES).toEqual(["web", "worker", "migrate", "all"]);
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
  });

  it("refuses an unknown role, a role in the wrong case and a missing role", () => {
    expect(parseRole("api")).toBeUndefined();
    expect(parseRole("WEB")).toBeUndefined();
    expect(parseRole(undefined)).toBeUndefined();
  });

  it("names the roles in its usage line", () => {
    expect(usage("api")).toBe('Unknown role "api". Usage: main.mjs <role>, where role is web, worker, migrate or all.');
    expect(usage(undefined)).toBe("No role given. Usage: main.mjs <role>, where role is web, worker, migrate or all.");
  });
});
