import { EVENT_TYPE_NAME, REQUEST_STATES, TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { eventActor } from "./request-activity.ts";
import { requestKeyOutput, teamRef } from "./request-refs.ts";
import { user } from "./schemas.ts";

// The live hall's reads (web-ui: The live hall; web-ui: What the live hall
// shows of the people and agents at work; activity-log: Security events are
// shown to admins only; design.md, Design: The live hall; D57 (11), (13)).
// hall.state answers what the page shows: every team with its live requests
// by state and those done within the last 24 hours; one line per ordered pair
// of teams with live requests between them; the 200 most recently changed
// live requests; the people and agents at work within the last 10 minutes,
// from events recorded as agent or web_session only; and the 50 latest domain
// events about requests in Tiehall's words, with the cursor, the number of the
// newest of them. `team` narrows the lines, the requests, the people and
// agents at work and the feed to the requests from or to that team, and
// `agents` the people at work and the feed to what agents did; every team is
// still listed. Domain events carry ids and never text, so neither a
// message's nor the packet's text reaches it, and a security event never
// does, for an admin either. Titles, team names and client names are text
// people and agents wrote and sit under untrusted. They are internal: no
// agent surface offers them, and every member may run them, as members.list.

const count = z.number().int().min(0);

/** The number of requests in each state that is not terminal. */
export const liveCounts = z.object({ open: count, claimed: count, in_progress: count, needs_info: count });

/** A team of the install, as the live hall shows it: its requests by live state, and those done within the last 24 hours. */
export const hallTeam = z.object({
  id: z.uuid(),
  key: z.string().regex(TEAM_KEY),
  /** The requests addressed to the team, by each state that is not terminal. */
  counts: liveCounts,
  /** How many requests addressed to the team reached done within the last 24 hours, and are done still. */
  doneLastDay: count,
  untrusted: z.object({ name: z.string() }),
});

/** The requests that are not terminal between an ordered pair of teams, from the requesting team to the target team. */
export const hallLine = z.object({ from: teamRef, to: teamRef, counts: liveCounts });

/** A request as the live hall names it: its key and title, its state, whether it waits for a person, and its line. */
export const hallRequestRef = z.object({
  id: z.uuid(),
  key: requestKeyOutput,
  state: z.enum(REQUEST_STATES),
  /** The requesting team. */
  from: teamRef,
  /** The target team. */
  to: teamRef,
  needsHuman: z.boolean(),
  untrusted: z.object({ title: z.string() }),
});

/** A request on a line of the live hall, with its claimant and when its latest domain event happened. */
export const hallRequest = hallRequestRef.extend({
  claimant: user.nullable(),
  changedAt: z.iso.datetime(),
});

/** A domain event about a request, as the live hall's feed says it. */
export const hallEvent = z.object({
  /** The event's number in the install's sequence, which a cursor names. */
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  type: z.string().regex(EVENT_TYPE_NAME),
  /** What happened, in Tiehall's own words, which hold no one's text. */
  line: z.string(),
  actor: eventActor,
  /** The team the person or agent acted for; none for Tiehall, an integration or the operator. */
  team: teamRef.nullable(),
  request: hallRequestRef,
});

/** A person or an agent at work: one per user, actor kind and client, with their latest event, on the request it was about. */
export const hallAtWork = z.object({
  actor: eventActor,
  at: z.iso.datetime(),
  type: z.string().regex(EVENT_TYPE_NAME),
  /** What they did last, in Tiehall's own words. */
  line: z.string(),
  /** The team they acted for. */
  team: teamRef.nullable(),
  request: hallRequestRef,
  /** Whether what they did last was to ask a blocking question that is still open: the request needs info, and they wait on an answer. */
  waiting: z.boolean(),
  /** Whether the map shows them: the 12 most recent. */
  onMap: z.boolean(),
});

/** How a member narrows the live hall: to the requests from or to one team, and to what agents did. */
const narrowing = {
  team: z
    .string()
    .regex(TEAM_KEY)
    .optional()
    .meta({ description: "A team's key: only the lines from or to that team, and the requests, people, agents and events on them." }),
  agents: z.boolean().optional().meta({ description: "Only the people and agents at work, and the feed's events, whose actor kind is agent." }),
};

export const readHallState = defineCommand({
  id: "hall.state",
  summary:
    "What the web UI's live hall shows: every team with its live requests by state and those done in the last 24 hours, the lines between teams, the most recently changed live requests, the people and agents at work and the 50 latest events about requests, with the cursor its wait starts from.",
  input: z.object(narrowing),
  output: z.object({
    /** The server's time, which the page's relative times count from. */
    now: z.iso.datetime(),
    /** The number of the newest domain event about a request, which the page's wait starts after; 0 before the first. */
    cursor: count,
    /** Every team, by key. */
    teams: z.array(hallTeam),
    lines: z.array(hallLine),
    /** The 200 most recently changed requests that are not terminal, the most recent first, each on its line. */
    requestLines: z.array(hallRequest),
    /** The people and agents at work within the last 10 minutes, the most recent first. */
    atWork: z.array(hallAtWork),
    /** The 50 latest domain events about requests, newest first. */
    feed: z.array(hallEvent),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

/** A request a wait's events name, as it is now: on its line, or, with terminal, gone from the hall. */
export const hallRequestChange = hallRequest.extend({
  /**
   * Whether the request left the hall: it reached a terminal state, or, in a
   * hall narrowed to a team, it no longer runs from or to that team, such as
   * after a reassignment.
   */
  terminal: z.boolean(),
});

/**
 * The live hall's long-poll (web-ui: The live hall's reads and its long-poll;
 * requester-loop: No push paths other than the hooks; design.md, Design: The
 * live hall; D57 (12)): it answers as soon as a domain event about a request
 * comes after the cursor, with the new events the narrowed feed shows, oldest
 * first, the requests all the new events name as they are now, every team's
 * and the narrowed lines' counts, the people and agents at work and the new
 * cursor; otherwise it holds the call at most 25 seconds and answers with no
 * events and the cursor it was given. Past 50 new events it answers, with no
 * events, that the page must read the state again. A security event never
 * ends it.
 */
export const waitForHall = defineCommand({
  id: "hall.wait",
  summary:
    "Wait for the live hall's next events: answers as soon as a domain event about a request comes after the cursor, with what changed, or with no events once 25 seconds pass; past 50 events it asks the page to read the state again.",
  input: z.object({
    after: z.coerce.number().int().min(0).meta({ description: "The cursor: the number of the newest domain event about a request the page has." }),
    ...narrowing,
  }),
  output: z.object({
    now: z.iso.datetime(),
    /** The number of the newest event this answer brings, or the cursor it was given when it brings none. */
    cursor: count,
    /** Whether more than 50 events came after the cursor, so the page must read the state again; the answer then brings nothing else. */
    reload: z.boolean(),
    /** The new events the narrowed feed shows, oldest first. */
    events: z.array(hallEvent),
    /** Every request the new events name, as it is now. */
    requestLines: z.array(hallRequestChange),
    /** Every team, by key, as hall.state lists them. */
    teams: z.array(hallTeam),
    /** The lines between teams, narrowed as hall.state narrows them. */
    lines: z.array(hallLine),
    /** The people and agents at work now. */
    atWork: z.array(hallAtWork),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "beta",
});

export const HALL_COMMANDS = [readHallState, waitForHall];
