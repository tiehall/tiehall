import { TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { user } from "./schemas.ts";

// The team operations (teams-and-roles: Teams; teams-and-roles: What admins
// and members may do; teams-and-roles: Team keys). Only admins manage teams,
// and only in the web UI: they are admin actions, internal commands that no
// agent surface offers. A user can belong to several teams, and a team may
// have no members. Team changes are not security events (design.md, Readings
// to confirm with the founder: R21), and they change no request, so they
// record no event. The web UI's teams page lists the teams, for admins only,
// with the keys each had before a rename and the people in each.
//
// A team's intake settings (agent-surfaces: Admins set a team's intake notes
// and required fields; design.md, Self-hosting decisions: S6; design.md,
// Readings to confirm with the founder: R10): its intake notes, which say how
// it wants requests filed, and the packet fields it requires of the requests
// people and agents open to it, among the acceptance criteria, code refs,
// links and a due date; the need is required in every packet anyway. Only
// admins set them, in the web UI. The notes are text an admin wrote, so
// wherever agents read them they sit under `untrusted` and are fenced.

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

/** The packet fields a team may require, by their names in the packet. */
export const INTAKE_FIELDS = ["acceptance_criteria", "code_refs", "links", "due_date"] as const;
export type IntakeField = (typeof INTAKE_FIELDS)[number];

/** The fields a team requires, each once. */
export const requiredFields = z
  .array(z.enum(INTAKE_FIELDS))
  .max(INTAKE_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, "Name each field once.")
  .meta({ description: "The packet fields the team requires: any of acceptance_criteria, code_refs, links and due_date." });

/** How a team wants requests filed, as an admin writes it: up to 20,000 characters, or nothing. */
export const intakeNotes = z.string().max(20_000);

/** A team's intake settings: its notes, under untrusted, since an admin wrote them, and the fields it requires. */
export const teamIntake = z.object({
  requiredFields,
  untrusted: z.object({ notes: z.string() }),
});

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

export const setTeamIntake = defineCommand({
  id: "teams.set_intake",
  summary: "Set a team's intake notes, which say how it wants requests filed, and the packet fields it requires of the requests opened to it.",
  input: z.object({ teamId: z.uuid(), notes: intakeNotes, requiredFields }),
  output: team.extend({ intake: teamIntake }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

/** A team as the teams page lists it: its key, the keys it had before, which still lead to it, its name, the people in it and its intake settings. */
export const listedTeam = team.extend({
  aliases: z.array(z.string()),
  members: z.array(user),
  intake: teamIntake,
});

export const listTeams = defineCommand({
  id: "teams.list",
  summary: "List the install's teams, each with its key, the keys it had before, its name and the people in it.",
  input: z.object({}),
  output: z.object({ teams: z.array(listedTeam) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "teams",
  surfaces: [],
  stability: "beta",
});

export const TEAM_COMMANDS = [createTeam, renameTeam, changeTeamKey, addTeamMember, removeTeamMember, setTeamIntake, listTeams];
