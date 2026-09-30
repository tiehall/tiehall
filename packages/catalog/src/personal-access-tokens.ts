import { z } from "zod";
import { defineCommand, SCOPES } from "./command.ts";

// Personal access tokens (agent-access: Personal access tokens are scoped,
// expiring and created in the web UI; agent-safety: Actions that need the
// confirmation step). A user creates one in the web UI only, with the
// confirmation step, so no agent surface offers it and a token cannot make
// another. It carries one or more of the three scopes and expires within the
// install's longest lifetime, 90 days unless an admin set a shorter one. Its
// value, which starts with th_pat_, is in the creation's output only: the
// confirmation's page shows it once, and Tiehall keeps only a hash of it.
// The web UI reads the install's PAT settings, to say how long a token may
// live.

/** The prefix of every personal access token's value. */
export const PERSONAL_ACCESS_TOKEN_PREFIX = "th_pat_";

/** The label a user gives a token, to tell their tokens apart: their own words, 1 to 100 characters. */
const tokenName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .meta({ description: "A label for the token, such as what uses it, to tell your tokens apart: 1 to 100 characters." });

export const createPersonalAccessToken = defineCommand({
  id: "personal_access_tokens.create",
  summary: "Create a personal access token for the signed-in user, with one or more scopes, that expires within the install's longest lifetime; its value is shown once.",
  input: z.object({
    name: tokenName,
    scopes: z
      .array(z.enum(SCOPES))
      .min(1)
      .max(SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Name each scope once.")
      .meta({ description: "What the token may do: one or more of requests:read, requests:write and contracts:report." }),
    expiresInDays: z
      .int()
      .min(1)
      .meta({ description: "How many days from now the token expires: at most 90, or the shorter longest lifetime an admin has set." }),
  }),
  output: z.object({
    tokenId: z.uuid(),
    token: z.string().startsWith(PERSONAL_ACCESS_TOKEN_PREFIX).meta({ description: "The token's value, which Tiehall shows this once and never again." }),
    expiresAt: z.iso.datetime(),
  }),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "beta",
});

export const getPersonalAccessTokenSettings = defineCommand({
  id: "personal_access_tokens.get_settings",
  summary: "Show whether personal access tokens are switched on in the install, and the longest lifetime a new one may have.",
  input: z.object({}),
  output: z.object({
    on: z.boolean().meta({ description: "Whether calls with personal access tokens are accepted." }),
    maxLifetimeDays: z.int().min(1).max(90).meta({ description: "The longest lifetime a new personal access token may have, in days." }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const PERSONAL_ACCESS_TOKEN_COMMANDS = [createPersonalAccessToken, getPersonalAccessTokenSettings];
