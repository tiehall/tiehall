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
