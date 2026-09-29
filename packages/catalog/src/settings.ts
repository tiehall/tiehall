import { SIGN_IN_POLICIES, WRITE_LIMITS } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";

// The install settings an admin changes in the web UI (agent-safety: Agent
// writes are limited per token and budgeted per install; sign-in: The sign-in
// policy; agent-safety: Actions that need the confirmation step;
// teams-and-roles: What admins and members may do). Each needs the confirmation step for that exact change, so no agent
// surface offers it. The web UI's sign-in policy page shows the policy in
// force, to admins only.

/** A daily budget of agent writes: a whole number from 1 to 1,000,000. */
const dailyWriteBudget = z
  .number()
  .int()
  .min(WRITE_LIMITS.minDailyWriteBudget)
  .max(WRITE_LIMITS.maxDailyWriteBudget)
  .meta({ description: "How many writes the install's agents may make per UTC day, from 1 to 1,000,000." });

export const setWriteBudget = defineCommand({
  id: "settings.set_write_budget",
  summary: "Set the install's daily budget of agent writes, 5,000 until an admin changes it.",
  input: z.object({ dailyWriteBudget }),
  output: z.object({ dailyWriteBudget: z.number().int(), previousBudget: z.number().int() }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "agent_access",
  surfaces: [],
  stability: "beta",
});

/** The sign-in policy's two settings. */
const signInPolicy = z.enum(SIGN_IN_POLICIES).meta({
  description: "organization_members_and_invited admits members of the connected organizations and invited people; invited_only admits only invited people as new members.",
});

export const setSignInPolicy = defineCommand({
  id: "settings.set_sign_in_policy",
  summary: "Set who may join the install by signing in: members of the connected installations' GitHub accounts and invited people, or invited people only.",
  input: z.object({ policy: signInPolicy }),
  output: z.object({ policy: signInPolicy, previousPolicy: signInPolicy }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "sign_in_policy",
  surfaces: [],
  stability: "beta",
});

export const getSignInPolicy = defineCommand({
  id: "settings.get_sign_in_policy",
  summary: "Show who may join the install by signing in.",
  input: z.object({}),
  output: z.object({ policy: signInPolicy }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "sign_in_policy",
  surfaces: [],
  stability: "beta",
});

export const SETTINGS_COMMANDS = [setWriteBudget, setSignInPolicy, getSignInPolicy];
