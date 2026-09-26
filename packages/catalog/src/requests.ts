import { REQUEST_KEY, REQUEST_STATES } from "@tiehall/core";
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

/** A request's key, such as FE-142: a team key, current or from before a rename, a hyphen and a number. */
export const requestKey = z
  .string()
  .regex(REQUEST_KEY, "A request key is a team key, a hyphen and a number, such as FE-142.")
  .meta({ description: "The request's key, such as FE-142; a key written with a team's earlier key names the same request." });

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

export const getRequest = defineCommand({
  id: "requests.get",
  summary: "Read a request by its key. Every member of the install can read every request.",
  input: z.object({ key: requestKey }),
  output: request,
  method: "GET",
  path: "/api/v1/requests/{key}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const listRequests = defineCommand({
  id: "requests.list",
  summary: "List the install's requests, newest first, optionally only those to one team or in one state.",
  input: z.object({
    targetTeam: teamKey.optional().meta({ description: "Only the requests addressed to the team with this key." }),
    state: z.enum(REQUEST_STATES).optional().meta({ description: "Only the requests in this state." }),
    limit: z.coerce.number().int().min(1).max(200).optional().meta({ description: "How many requests to return, 1 to 200; 50 unless given." }),
    offset: z.coerce.number().int().min(0).optional().meta({ description: "How many of the newest requests to skip; 0 unless given." }),
  }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  output: z.object({ "requests": z.array(request) }),
  method: "GET",
  path: "/api/v1/requests",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const claimRequest = defineCommand({
  id: "requests.claim",
  summary: "Claim an open request of one of your teams for yourself; it needs no confirmation.",
  input: z.object({ key: requestKey }),
  output: request,
  method: "POST",
  path: "/api/v1/requests/{key}/claim",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

/** The states set_status moves a request to directly: in_progress starts work, and open releases the claim. */
export const DIRECT_STATES = ["in_progress", "open"] as const;

export const setRequestStatus = defineCommand({
  id: "requests.set_status",
  summary:
    "Change a request's state: in_progress starts work on a claimed request, and open releases its claim, which the claimant may do, or a member of its target team once the claimant is no longer a member.",
  input: z.object({
    key: requestKey,
    state: z.enum(DIRECT_STATES).meta({ description: "in_progress to start work on the claimed request, or open to release its claim." }),
  }),
  output: request,
  method: "POST",
  path: "/api/v1/requests/{key}/status",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const REQUEST_COMMANDS = [createRequest, getRequest, listRequests, claimRequest, setRequestStatus];
