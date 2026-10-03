import { SIGN_IN_POLICIES, WRITE_LIMITS } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";

// The install settings an admin changes in the web UI (agent-safety: Agent
// writes are limited per token and budgeted per install; sign-in: The sign-in
// policy; agent-access: An admin sets the PAT switch and the maximum lifetime;
// agent-safety: Actions that need the confirmation step; teams-and-roles: What
// admins and members may do). Each needs the confirmation step for that exact
// change, so no agent surface offers it. The web UI's sign-in policy page
// shows the policy in force, its personal access tokens page the PAT switch
// and the longest lifetime, and its admin page the daily budget of agent
// writes, to admins only.

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

export const setPersonalAccessTokens = defineCommand({
  id: "settings.set_personal_access_tokens",
  summary: "Switch personal access tokens on or off for the install: while they are off, every call with one is refused, and switching them on again lets unexpired ones work again.",
  input: z.object({ on: z.boolean().meta({ description: "true to accept calls with personal access tokens, false to refuse them all." }) }),
  output: z.object({ on: z.boolean(), previousOn: z.boolean() }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "agent_access",
  surfaces: [],
  stability: "beta",
});

/** The longest lifetime of a new personal access token: 1 to 90 days. */
const maxLifetimeDays = z.int().min(1).max(90).meta({ description: "The longest lifetime a new personal access token may have, from 1 to 90 days." });

export const setPersonalAccessTokenMaxLifetime = defineCommand({
  id: "settings.set_personal_access_token_max_lifetime",
  summary: "Set the longest lifetime a new personal access token may have, from 1 to 90 days, 90 until an admin changes it; tokens that exist keep their expiry.",
  input: z.object({ maxLifetimeDays }),
  output: z.object({ maxLifetimeDays: z.int(), previousMaxLifetimeDays: z.int() }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "agent_access",
  surfaces: [],
  stability: "beta",
});

export const getPersonalAccessTokenAdminSettings = defineCommand({
  id: "settings.get_personal_access_tokens",
  summary: "Show an admin whether personal access tokens are switched on, and the longest lifetime a new one may have.",
  input: z.object({}),
  output: z.object({ on: z.boolean(), maxLifetimeDays: z.int() }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "agent_access",
  surfaces: [],
  stability: "beta",
});

export const getWriteBudget = defineCommand({
  id: "settings.get_write_budget",
  summary: "Show an admin the install's daily budget of agent writes.",
  input: z.object({}),
  output: z.object({ dailyWriteBudget: z.number().int() }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "agent_access",
  surfaces: [],
  stability: "beta",
});

export const SETTINGS_COMMANDS = [
  setWriteBudget,
  getWriteBudget,
  setSignInPolicy,
  getSignInPolicy,
  setPersonalAccessTokens,
  setPersonalAccessTokenMaxLifetime,
  getPersonalAccessTokenAdminSettings,
];
