import { REQUEST_KEY, REQUEST_STATES, SURFACES, TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet } from "./packet.ts";
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
// (agent-safety: User text in JSON sits under untrusted objects). Outputs name
// requests and teams by keys whose schemas close them to their form, which
// holds no space.

/** A team as a request names it: its id and its current key. */
export const teamRef = z.object({ id: z.uuid(), key: z.string().regex(TEAM_KEY) });

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

/** A request's key as outputs write it, with its target team's current key. */
export const requestKeyOutput = z.string().regex(REQUEST_KEY);

/** A request as other records name it: its id and its key. */
export const requestRef = z.object({ id: z.uuid(), key: requestKeyOutput });

/** A request as the request operations return it. */
export const request = z.object({
  id: z.uuid(),
  /** Its key, such as FE-142, written with its target team's current key. */
  key: requestKeyOutput,
  state: z.enum(REQUEST_STATES),
  targetTeam: teamRef,
  /** Who opened it: the user, and the team they opened it from. */
  requester: z.object({ user: user.nullable(), team: teamRef }),
  /** Who holds its claim; null while it is unclaimed. */
  claimant: user.nullable(),
  createdAt: z.iso.datetime(),
  /** Whether agents made so many writes on it that it waits for a person, who clears it with a message in the web UI. */
  needsHuman: z.boolean().meta({
    description: "Whether it waits for a person: agents made too many writes on it, so they get 409 needs-human until a member posts a message on it in the web UI.",
  }),
  untrusted: z.object({ title: z.string() }),
});

export const MESSAGE_KINDS = ["comment", "question", "answer"] as const;

/** The actor kinds a message's provenance records; human stays reserved and is never recorded in v1. */
const RECORDED_ACTOR_KINDS = ["agent", "web_session", "system", "integration"] as const;

/** A message of a request's thread, as the operations return it, with its latest version's text. */
export const message = z.object({
  id: z.uuid(),
  kind: z.enum(MESSAGE_KINDS),
  /** Whether a question blocks its request until it is answered; false for every other kind. */
  blocking: z.boolean(),
  /** For an answer, the question it answers. */
  questionId: z.uuid().nullable(),
  /** For a question, whether it has an answer; null for every other kind. */
  answered: z.boolean().nullable(),
  /** The number of its latest version: 1 until it is edited. */
  version: z.number().int().min(1),
  postedAt: z.iso.datetime(),
  /** When its latest version was added; null until it is edited. */
  editedAt: z.iso.datetime().nullable(),
  /** Who posted it, as the server stamped it: the actor kind, the surface, the accountable human and the team. */
  provenance: z.object({
    actorKind: z.enum(RECORDED_ACTOR_KINDS),
    surface: z.enum(SURFACES).nullable(),
    user: user.nullable(),
    team: teamRef.nullable(),
  }),
  untrusted: z.object({ body: z.string(), client: z.string().nullable() }),
});

/** A request with its thread, oldest message first. */
export const requestWithThread = request.extend({ messages: z.array(message) });

export const createRequest = defineCommand({
  id: "requests.create",
  summary:
    "Open a request to a team of the install, from one of the teams you belong to, with its packet, which becomes revision 1; your only team is the default, and a member of several teams names one.",
  input: z.object({
    targetTeam: teamKey.meta({ description: "The key of the team the request is addressed to, such as FE." }),
    requestingTeam: teamKey
      .optional()
      .meta({ description: "The key of the team you open it from, one of yours; needed when you belong to several teams." }),
    title: requestTitle.meta({ description: "The request's title: one line of 1 to 200 characters." }),
    packet,
  }),
  output: request,
  method: "POST",
  path: "/api/v1/requests",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp"],
  tool: "open_request",
  stability: "alpha",
});

export const getRequest = defineCommand({
  id: "requests.get",
  summary: "Read a request by its key, with its thread. Every member of the install can read every request.",
  input: z.object({ key: requestKey }),
  output: requestWithThread,
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

export const listInbox = defineCommand({
  id: "requests.inbox",
  summary:
    "List the requests addressed to your teams, newest first, optionally only those in one state; a member of no team has none.",
  input: z.object({
    state: z.enum(REQUEST_STATES).optional().meta({ description: "Only the requests in this state." }),
    limit: z.coerce.number().int().min(1).max(50).optional().meta({ description: "How many requests to return, 1 to 50; 20 unless given." }),
    offset: z.coerce.number().int().min(0).optional().meta({ description: "How many of the newest requests to skip; 0 unless given." }),
  }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  output: z.object({ "requests": z.array(request) }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["mcp"],
  tool: "list_inbox",
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
  surfaces: ["rest", "mcp"],
  tool: "claim",
  stability: "alpha",
});

/** The states set_status moves a request to directly: in_progress starts work, and open releases the claim. */
export const DIRECT_STATES = ["in_progress", "open"] as const;

/** The states set_status proposes, as commitments a person confirms: declined and done. */
export const PROPOSED_STATES = ["declined", "done"] as const;

export const setRequestStatus = defineCommand({
  id: "requests.set_status",
  summary:
    "Change a request's state: in_progress starts work on a claimed request, and open releases its claim, which the claimant may do, or a member of its target team once the claimant is no longer a member. declined and done are commitments: they create a proposal that people confirm in the web UI, answered with 202, and leave the request as it is; done on a request that is done already answers with the request.",
  input: z.object({
    key: requestKey,
    state: z.enum([...DIRECT_STATES, ...PROPOSED_STATES]).meta({
      description: "in_progress to start work on the claimed request, open to release its claim, or declined or done to propose declining it or marking it done.",
    }),
  }),
  output: request,
  method: "POST",
  path: "/api/v1/requests/{key}/status",
  scopes: ["requests:write"],
  commitment: true,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const proposeCommitment = defineCommand({
  id: "requests.propose",
  summary:
    "Propose a commitment that no other operation makes, which people confirm in the web UI, answered with 202 and the proposal: reassign the request to another team of the install, as a member of its target team, or withdraw it, as its requester side.",
  input: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("reassign").meta({ description: "Reassign the request to another team of the install." }),
      key: requestKey,
      team: teamKey.meta({ description: "The key of the team to reassign it to, such as MOB." }),
    }),
    z.object({
      kind: z.literal("withdraw").meta({ description: "Withdraw the request." }),
      key: requestKey,
    }),
  ]),
  output: request,
  method: "POST",
  path: "/api/v1/requests/{key}/proposals",
  scopes: ["requests:write"],
  commitment: true,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const REQUEST_COMMANDS = [createRequest, getRequest, listRequests, listInbox, claimRequest, setRequestStatus, proposeCommitment];
