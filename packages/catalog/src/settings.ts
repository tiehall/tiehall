import { WRITE_LIMITS } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";

// The install settings an admin changes in the web UI (agent-safety: Agent
// writes are limited per token and budgeted per install; agent-safety: Actions
// that need the confirmation step; teams-and-roles: What admins and members
// may do). Each needs the confirmation step for that exact change, so no agent
// surface offers it.

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

export const SETTINGS_COMMANDS = [setWriteBudget];
