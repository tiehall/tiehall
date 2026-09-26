import { ROLES } from "@tiehall/core";
import { z } from "zod";

// Schemas that several definitions share, so every input that names the same
// thing parses it the same way.

/**
 * A role that an invite or a role change names: admin or member, and no other,
 * such as owner, which fails the schema and so gets 400 (teams-and-roles: Two
 * roles, admin and member).
 */
export const role = z.enum(ROLES);

/**
 * A user as every output that names one shows them: their id, their GitHub
 * login, their kind, which is human for every user in v1, and whether an admin
 * flagged them as a bot, so a bot is marked wherever a user is listed or named
 * (teams-and-roles: Bot users).
 */
export const user = z.object({
  id: z.uuid(),
  login: z.string(),
  kind: z.literal("human"),
  bot: z.boolean(),
});
