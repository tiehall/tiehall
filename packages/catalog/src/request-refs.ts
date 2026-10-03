import { REQUEST_KEY, TEAM_KEY } from "@tiehall/core";
import { z } from "zod";

// How the operations name requests and teams (requests: Per-team request
// keys; public-api: One definition per operation, the same on every surface):
// by ids and keys, whose schemas close them to their form, which holds no
// space. They sit apart from the request operations so that the proposals,
// which name their request, and the request's read, which lists its pending
// proposals, can both use them.

/** A team as a request names it: its id and its current key. */
export const teamRef = z.object({ id: z.uuid(), key: z.string().regex(TEAM_KEY) });

/** A request's key, such as FE-142: a team key, current or from before a rename, a hyphen and a number. */
export const requestKey = z
  .string()
  .regex(REQUEST_KEY, "A request key is a team key, a hyphen and a number, such as FE-142.")
  .meta({ description: "The request's key, such as FE-142; a key written with a team's earlier key names the same request." });

/** A request's key as outputs write it, with its target team's current key. */
export const requestKeyOutput = z.string().regex(REQUEST_KEY);

/** A request as other records name it: its id and its key. */
export const requestRef = z.object({ id: z.uuid(), key: requestKeyOutput });
