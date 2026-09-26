import { TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";

// The team operations (teams-and-roles: Teams; teams-and-roles: What admins
// and members may do; teams-and-roles: Team keys). Only admins manage teams,
// and only in the web UI: they are admin actions, internal commands that no
// agent surface offers. A user can belong to several teams, and a team may
// have no members. Team changes are not security events (design.md, Readings
// to confirm with the founder: R21), and they change no request, so they
// record no event.

/** A team, as the team operations return it. */
export const team = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
});

/** A team's name, as an admin gives it. */
const teamName = z.string().trim().min(1).max(100);

/**
 * A team's key, such as FE or PAY2: 2 to 10 uppercase letters and digits that
 * start with a letter. A key in any other form fails the schema and gets 400.
 */
export const teamKey = z.string().regex(TEAM_KEY, "A team key has 2 to 10 uppercase letters and digits and starts with a letter.");

const membership = z.object({ teamId: z.uuid(), userId: z.uuid() });

export const createTeam = defineCommand({
  id: "teams.create",
  summary: "Create a team with a key and a name, and nobody in it.",
  input: z.object({ key: teamKey, name: teamName }),
  output: team,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const renameTeam = defineCommand({
  id: "teams.rename",
  summary: "Change a team's name.",
  input: z.object({ teamId: z.uuid(), name: teamName }),
  output: team,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const changeTeamKey = defineCommand({
  id: "teams.change_key",
  summary: "Change a team's key.",
  input: z.object({ teamId: z.uuid(), key: teamKey }),
  output: team,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const addTeamMember = defineCommand({
  id: "teams.add_member",
  summary: "Add a member of the install to a team.",
  input: membership,
  output: membership,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const removeTeamMember = defineCommand({
  id: "teams.remove_member",
  summary: "Remove a person from a team.",
  input: membership,
  output: membership,
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const TEAM_COMMANDS = [createTeam, renameTeam, changeTeamKey, addTeamMember, removeTeamMember];
