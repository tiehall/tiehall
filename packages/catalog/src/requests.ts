import { REQUEST_STATES, SURFACES } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { packet, PROVIDER_STATUSES } from "./packet.ts";
import { proposal } from "./proposals.ts";
import { requestKey, requestKeyOutput, teamRef } from "./request-refs.ts";
import { API_NAME, GITHUB_REPOSITORY, PULL_REQUEST_URL, user } from "./schemas.ts";
import { teamKey } from "./teams.ts";

export { requestKey, requestKeyOutput, requestRef, teamRef } from "./request-refs.ts";

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


/** A request's title, as its requester writes it: one line of 1 to 200 characters. */
export const requestTitle = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]*$/, "A title is one line, without control characters.");

/**
 * The day on or after which `providerChange.api`, deprecated on 2026-10-12 for
 * `providerChange.untrusted.api`, may be removed: at least 14 days later, as a
 * beta operation's notice asks (public-api: Notice before a breaking change is
 * enforced in CI; decisions-from-groups-15-28: design.md, Decisions this
 * change rests on: D55 (80)).
 */
export const PROVIDER_CHANGE_API_SUNSET = "2026-11-09";

/**
 * The provider change a contract-change request follows: the registered API,
 * by its provider team and its name, the provider pull request, and what
 * became of it, as Tiehall learned it from GitHub (contract-changes: Merging
 * the provider PR marks the change shipped; contract-changes: Requests are
 * withdrawn when the provider PR closes unmerged). The API's name, which an
 * admin wrote, is its provider team's text, so it sits under an untrusted
 * object (agent-safety: User text in JSON sits under untrusted objects;
 * decisions-from-groups-15-28, D55 (80)); the name outside it is deprecated
 * until its sunset. The repository and the URL are GitHub's own identifiers,
 * and stay outside.
 */
export const providerChange = z.object({
  api: z.string().regex(API_NAME).meta({
    description: "Deprecated: read untrusted.api instead. The registered API the provider change is to, such as payments-api.",
    deprecated: true,
    "x-sunset": PROVIDER_CHANGE_API_SUNSET,
  }),
  provider: teamRef.meta({ description: "The team that provides the API, whose text its name is." }),
  pullRequest: z
    .object({
      repository: z.string().regex(GITHUB_REPOSITORY).meta({ description: "The provider pull request's repository, as owner/name." }),
      number: z.number().int().min(1),
      url: z.string().regex(PULL_REQUEST_URL).meta({ description: "The provider pull request's URL on GitHub.com." }),
    })
    .meta({ description: "The provider pull request that makes the change." }),
  status: z.enum(PROVIDER_STATUSES).meta({
    description: "open while the provider pull request is open; closed once it closed without merging; merged once it merged, which shipped the change.",
  }),
  shippedAt: z.iso.datetime().nullable().meta({ description: "When the provider pull request merged, which shipped the change; null until it has." }),
  untrusted: z.object({
    api: z.string().meta({ description: "The name of the registered API the provider change is to, such as payments-api, as an admin registered it: its provider team's text." }),
  }),
});

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
  /** Whether agents made so many writes on it that it waits for a person, who clears it with a message or a confirmation in the web UI. */
  needsHuman: z.boolean().meta({
    description:
      "Whether it waits for a person: agents made too many writes on it, so they get 409 needs-human until a member posts a message on it in the web UI or confirms a proposal on it there.",
  }),
  /** For a request a contract report opened, the provider change it follows; null for any other request. */
  providerChange: providerChange.nullable().meta({
    description: "For a contract-change request, which a contract report opened, the provider change it follows and whether it shipped; null for any other request.",
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

/**
 * A request with its thread, oldest message first, and its pending proposals,
 * oldest first, each as proposals.get returns it: what waits for people to
 * confirm or reject it in the web UI. A proposal holds no confirm URL, so the
 * read, and the markdown of the request's URL that renders it, holds none
 * (agent-safety: The confirm URL never reaches the model).
 */
export const requestWithThread = request.extend({
  messages: z.array(message),
  pendingProposals: z.array(proposal).meta({
    description: "The request's pending proposals, oldest first, each as proposals.get returns it, which people confirm or reject in the web UI.",
  }),
});

export const createRequest = defineCommand({
  id: "requests.create",
  summary:
    "Open a request to a team of the install, from one of the teams you belong to, with its packet, which becomes revision 1; your only team is the default, and a member of several teams names one. The packet must hold every field the target team requires, which directory lists; a request that lacks one is refused as invalid input naming each missing field, and nothing is opened.",
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
  surfaces: ["rest", "mcp", "cli"],
  tool: "open_request",
  cli: [{ command: "open", arguments: ["targetTeam"] }],
  stability: "beta",
});

export const getRequest = defineCommand({
  id: "requests.get",
  summary: "Read a request by its key, with its thread and its pending proposals. Every member of the install can read every request.",
  input: z.object({ key: requestKey }),
  output: requestWithThread,
  method: "GET",
  path: "/api/v1/requests/{key}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "beta",
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
  stability: "beta",
});

export const listInbox = defineCommand({
  id: "requests.inbox",
  summary:
    "List the requests addressed to your teams that are not finished, newest first: those not done, declined or withdrawn, unless state names one state, a finished one included; a member of no team has none.",
  input: z.object({
    state: z
      .enum(REQUEST_STATES)
      .optional()
      .meta({ description: "Only the requests in this state, such as done; without it, only the requests that are not done, declined or withdrawn." }),
    limit: z.coerce.number().int().min(1).max(50).optional().meta({ description: "How many requests to return, 1 to 50; 20 unless given." }),
    offset: z.coerce.number().int().min(0).optional().meta({ description: "How many of the newest requests to skip; 0 unless given." }),
  }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  output: z.object({ "requests": z.array(request) }),
  method: "GET",
  path: "/api/v1/inbox",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp", "cli"],
  tool: "list_inbox",
  cli: [{ command: "inbox" }],
  stability: "beta",
});

export const listOpenedRequests = defineCommand({
  id: "requests.list_opened",
  summary:
    "List the requests you opened, newest first, optionally only those in one state, for the web UI's request lists. Offered on no agent surface.",
  input: z.object({
    state: z.enum(REQUEST_STATES).optional().meta({ description: "Only the requests in this state." }),
    limit: z.coerce.number().int().min(1).max(200).optional().meta({ description: "How many requests to return, 1 to 200; 50 unless given." }),
    offset: z.coerce.number().int().min(0).optional().meta({ description: "How many of the newest requests to skip; 0 unless given." }),
  }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  output: z.object({ "requests": z.array(request) }),
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: [],
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
  surfaces: ["rest", "mcp", "cli"],
  tool: "claim",
  cli: [{ command: "claim", arguments: ["key"] }],
  stability: "beta",
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
  surfaces: ["rest", "mcp", "cli"],
  tool: "set_status",
  cli: [{ command: "status", arguments: ["key", "state"] }],
  stability: "beta",
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
  stability: "beta",
});

export const REQUEST_COMMANDS = [createRequest, getRequest, listRequests, listInbox, listOpenedRequests, claimRequest, setRequestStatus, proposeCommitment];
