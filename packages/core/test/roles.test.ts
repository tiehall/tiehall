import { describe, expect, it } from "vitest";
import {
  ADMIN_ACTIONS,
  allows,
  isRole,
  leavesNoAdmin,
  roleAllows,
  ROLES,
  type Access,
  type AdminAction,
  type MembershipChange,
  type Part,
  type Role,
} from "../src/index.ts";

// The role matrix (teams-and-roles: Two roles, admin and member;
// teams-and-roles: What admins and members may do; teams-and-roles: The role
// bounds every caller acting for a user; design.md, Decisions this change rests
// on: D28 #4; design.md, Self-hosting decisions: S6). Each member holds one of
// two roles. Only admins take the admin actions; every other action is either
// open to every member or decided by the person's part in the record, such as
// belonging to a request's target team, and never by their role.

describe("the roles", () => {
  it("are exactly admin and member", () => {
    expect(ROLES).toEqual(["admin", "member"]);
  });

  it.each([
    ["admin", true],
    ["member", true],
    ["owner", false],
    ["Admin", false],
    ["", false],
    [undefined, false],
  ])("take %j as a role: %s", (value, expected) => {
    expect(isRole(value)).toBe(expected);
  });
});

describe("the admin actions", () => {
  it("are the nine items of the spec's list of what only admins may do", () => {
    expect(ADMIN_ACTIONS).toEqual([
      "members",
      "teams",
      "sign_in_policy",
      "integrations",
      "apis",
      "agent_access",
      "bot_flag",
      "fan_out",
      "activity_log",
    ]);
  });

  const rows: [Role, AdminAction, boolean][] = ADMIN_ACTIONS.flatMap((action): [Role, AdminAction, boolean][] => [
    ["admin", action, true],
    ["member", action, false],
  ]);

  it.each(rows)("for the role %s, %s is allowed: %s", (role, action, expected) => {
    expect(roleAllows(role, action)).toBe(expected);
  });
});

describe("who may take an action", () => {
  const admin = (...parts: Part[]) => ({ role: "admin" as const, parts });
  const member = (...parts: Part[]) => ({ role: "member" as const, parts });
  const teams: Access = { kind: "admin", action: "teams" };
  const anyMember: Access = { kind: "member" };
  // What a request's target team may do, such as claiming it.
  const targetTeam: Access = { kind: "part", parts: ["target_team"] };
  // What the requester side may do, such as withdrawing.
  const requesterSide: Access = { kind: "part", parts: ["requester_side"] };
  // What a team's members may do on its records, such as declaring the APIs it consumes.
  const teamMember: Access = { kind: "part", parts: ["team_member"] };

  it.each([
    ["an admin", admin(), teams, true],
    ["a member", member(), teams, false],
    ["a member of the team", member("team_member"), teams, false],
    ["an admin", admin(), anyMember, true],
    ["a member", member(), anyMember, true],
    // The admin role grants no part in a request.
    ["an admin in no team of the request", admin(), targetTeam, false],
    ["an admin on the requester side", admin("requester_side"), targetTeam, false],
    ["an admin who claims it", admin("claimant"), requesterSide, false],
    ["a member of the target team", member("target_team"), targetTeam, true],
    ["an admin in the target team", admin("target_team"), targetTeam, true],
    ["a member on the requester side", member("requester_side"), requesterSide, true],
    // A team's own members act on its records whatever their role.
    ["a member of the team", member("team_member"), teamMember, true],
    ["an admin outside the team", admin(), teamMember, false],
  ])("%s: allowed %s on %j is %s", (_who, actor, access, expected) => {
    expect(allows(actor, access)).toBe(expected);
  });
});

describe("keeping at least one admin", () => {
  const ADA = "ada";
  const OMAR = "omar";
  const DANA = "dana";
  const rows: [string, readonly string[], MembershipChange, boolean][] = [
    ["the only admin steps down", [ADA], { kind: "role", userId: ADA, role: "member" }, true],
    ["the only admin is removed", [ADA], { kind: "removal", userId: ADA }, true],
    ["one of two admins steps down", [ADA, OMAR], { kind: "role", userId: ADA, role: "member" }, false],
    ["one of two admins is removed", [ADA, OMAR], { kind: "removal", userId: ADA }, false],
    ["a member is removed", [ADA], { kind: "removal", userId: DANA }, false],
    ["a member is made an admin", [ADA], { kind: "role", userId: DANA, role: "admin" }, false],
    ["the only admin is made an admin again", [ADA], { kind: "role", userId: ADA, role: "admin" }, false],
    ["a member stays a member", [ADA], { kind: "role", userId: DANA, role: "member" }, false],
  ];

  it.each(rows)("%s: leaves no admin is %s", (_what, admins, change, expected) => {
    expect(leavesNoAdmin(admins, change)).toBe(expected);
  });
});
