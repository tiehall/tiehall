import { z } from "zod";
import { defineCommand } from "./command.ts";
import { role, user } from "./schemas.ts";

// The operations on the install's members (teams-and-roles: Changing a
// member's role; teams-and-roles: Removing a member; teams-and-roles: What
// admins and members may do; agent-safety: Actions that need the confirmation
// step). Only admins run them, in the web
// UI, and each needs the confirmation step for that exact action, so no agent
// surface offers them.

export const changeMemberRole = defineCommand({
  id: "members.change_role",
  summary: "Change a member's role between member and admin.",
  input: z.object({ userId: z.uuid(), role }),
  output: z.object({ userId: z.uuid(), role }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const removeMember = defineCommand({
  id: "members.remove",
  summary: "Remove a member from the install and from its teams, and block their GitHub account from rejoining without an invite.",
  input: z.object({ userId: z.uuid() }),
  output: z.object({ userId: z.uuid() }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const setBotFlag = defineCommand({
  id: "users.set_bot_flag",
  summary: "Set or clear the flag that marks a user as a bot.",
  input: z.object({ userId: z.uuid(), bot: z.boolean() }),
  output: z.object({ userId: z.uuid(), bot: z.boolean() }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "bot_flag",
  surfaces: [],
  stability: "beta",
});

/** A member of the install, as the members list shows them: the user, their role and the keys of their teams. */
export const listedMember = user.extend({ role, teams: z.array(z.string()) });

export const listMembers = defineCommand({
  id: "members.list",
  summary: "List the install's members, with their roles, their teams and whether they are bots.",
  input: z.object({}),
  output: z.object({ members: z.array(listedMember) }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const MEMBER_COMMANDS = [changeMemberRole, removeMember, setBotFlag, listMembers];
