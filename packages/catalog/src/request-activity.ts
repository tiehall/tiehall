import { EVENT_TYPE_NAME, REQUEST_STATES, SEMANTIC_VERSION } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { requestKey, requestKeyOutput } from "./request-refs.ts";
import { user } from "./schemas.ts";

// The read behind a request's page's activity (web-ui: The request page shows
// who works on it and what happened; web-ui: What the live hall shows of the
// people and agents at work; design.md, Design: The request page's activity;
// D57 (15)): from the request's own domain events, who wrote on it last, as
// an agent or in the web UI, and when; whether that person's agent is at work
// on it now, which it is while the request is in_progress and that write is an
// agent's under 10 minutes old; and its 20 latest domain events, newest first,
// each in Tiehall's words with who caused it, when, and the state it left the
// request in; and who posted each message of its thread, named the same way,
// with the client, for the thread's messages on the page. Events carry ids, never text, so the read holds no message's or
// packet's text; a client's name is the client's own claim and sits under
// untrusted. It is internal: no agent surface offers it, and every member may
// run it, as members.list.

/** A client that acted for a user, as Tiehall names it (design.md, Design: The live hall, Who is at work). */
export const actorClient = z.object({
  /**
   * How the client is known: by its Client ID Metadata Document, whose host
   * Tiehall verified; registered through Dynamic Client Registration, so
   * nothing verifies it; the tiehall CLI; or a personal access token.
   */
  kind: z.enum(["metadata_document", "registered", "cli", "personal_access_token"]),
  /** The verified host of a metadata document's URL; none for any other client. */
  host: z.string().regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/).nullable(),
  /** The tiehall CLI's version, when its calls name one. */
  version: z.string().regex(SEMANTIC_VERSION).nullable(),
  /** Whether nothing verifies who the client is: a registered client. */
  unverified: z.boolean(),
  untrusted: z.object({
    /** The name the client gives itself, cut to 40 characters; none when it gave none, or for the CLI and a personal access token. */
    name: z.string().max(40).nullable(),
  }),
});

/**
 * Who caused an event: a user's agent, with its client; a user in the web UI;
 * Tiehall itself (a system action); GitHub or Jira (an integration, by the
 * surface it came through); or the operator, by a command on the host.
 */
export const eventActor = z.object({
  kind: z.enum(["agent", "web", "tiehall", "github", "jira", "operator"]),
  /** The user an agent or a web session acted for; none for the other kinds. */
  user: user.nullable(),
  /** An agent's client; none for the other kinds. */
  client: actorClient.nullable(),
});

/** One domain event about a request, as the request page's timeline and the live hall's feed say it. */
export const requestActivityEvent = z.object({
  /** The event's number in the install's sequence. */
  number: z.number().int().positive(),
  type: z.string().regex(EVENT_TYPE_NAME),
  at: z.iso.datetime(),
  /** The state the event left the request in. */
  state: z.enum(REQUEST_STATES),
  /** What happened, in Tiehall's own words, which hold no one's text. */
  line: z.string(),
  actor: eventActor,
});

export const requestActivity = defineCommand({
  id: "requests.activity",
  summary: "Who wrote on a request last, whether their agent is at work on it now, and its 20 latest domain events, for the request's page in the web UI.",
  input: z.object({ key: requestKey }),
  output: z.object({
    /** The server's time, which the page's relative times count from. */
    now: z.iso.datetime(),
    request: z.object({ id: z.uuid(), key: requestKeyOutput, state: z.enum(REQUEST_STATES) }),
    /** The latest domain event on the request that an agent or a web session caused; none before the first. */
    lastWrite: z.object({ at: z.iso.datetime(), actor: eventActor }).nullable(),
    /** Whether the request is in_progress and its last write is an agent's under 10 minutes old. */
    agentAtWork: z.boolean(),
    /** The request's 20 latest domain events, newest first. */
    events: z.array(requestActivityEvent),
    /** Who posted each message of the request's thread, in the thread's order, named as the events name their actors. */
    authors: z.array(z.object({ messageId: z.uuid(), actor: eventActor })),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const REQUEST_ACTIVITY_COMMANDS = [requestActivity];
