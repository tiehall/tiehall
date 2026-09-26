import { REQUEST_STATES } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { user } from "./schemas.ts";
import { teamKey } from "./teams.ts";

// The request operations (requests: A request is addressed to a team of the
// install; requests: The requester picks the requesting team; requests:
// Request states; requests: Per-team request keys; public-api: One definition
// per operation, the same on every surface). They are offered on /api/v1 at
// the alpha level while the later tasks of this change shape them: the packet,
// the proposals and the agent surfaces that come with MCP and the CLI.
//
// Text a user wrote, such as a request's title, sits under an object named
// `untrusted`, apart from the key, the state and the ids Tiehall writes
// (agent-safety: User text in JSON sits under untrusted objects).

/** A team as a request names it: its id and its current key. */
export const teamRef = z.object({ id: z.uuid(), key: z.string() });

/** A request's title, as its requester writes it: one line of 1 to 200 characters. */
export const requestTitle = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]*$/, "A title is one line, without control characters.");

/** A request as the request operations return it. */
export const request = z.object({
  id: z.uuid(),
  /** Its key, such as FE-142, written with its target team's current key. */
  key: z.string(),
  state: z.enum(REQUEST_STATES),
  targetTeam: teamRef,
  /** Who opened it: the user, and the team they opened it from. */
  requester: z.object({ user: user.nullable(), team: teamRef }),
  /** Who holds its claim; null while it is unclaimed. */
  claimant: user.nullable(),
  createdAt: z.iso.datetime(),
  untrusted: z.object({ title: z.string() }),
});

export const createRequest = defineCommand({
  id: "requests.create",
  summary:
    "Open a request to a team of the install, from one of the teams you belong to; your only team is the default, and a member of several teams names one.",
  input: z.object({
    targetTeam: teamKey.meta({ description: "The key of the team the request is addressed to, such as FE." }),
    requestingTeam: teamKey
      .optional()
      .meta({ description: "The key of the team you open it from, one of yours; needed when you belong to several teams." }),
    title: requestTitle.meta({ description: "The request's title: one line of 1 to 200 characters." }),
  }),
  output: request,
  method: "POST",
  path: "/api/v1/requests",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const REQUEST_COMMANDS = [createRequest];
