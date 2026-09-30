import { EVENT_TYPE_NAME, REQUEST_KEY, TEAM_KEY } from "@tiehall/core";
import { z } from "zod";
import { defineCommand } from "./command.ts";
import { eventView } from "./events.ts";
import { request, requestKeyOutput, teamRef } from "./requests.ts";
import { INSTALL_URL } from "./schemas.ts";

// The pull readers of the requester loop (requester-loop: The pull readers;
// requester-loop: Pull is the contract; requester-loop: What whats_new covers;
// requests: Read cursors move only on acknowledgement; requests: Readers get
// only domain events they may see; design.md, Decisions this change rests on:
// D28 #58, #60; design.md, Design rules: Requester loop). A pull reader
// returns the user's updates after the cursor of the client that reads, oldest
// first, a page at a time, and takes acknowledgements, which alone move that
// cursor. An update is a domain event on a request in the reader's scope: its
// number, type, time and the ids and fixed values it carries, with its
// request's key, target team and URL on the install, which are Tiehall's own
// text; the answer also holds the requests the updates are about, whose
// titles, which people wrote, sit under `untrusted` (agent-safety: User text
// in JSON sits under untrusted objects). Security events are never updates.
//
// whats_new, which is also `tiehall updates`, covers the requests the user
// opened, claimed or is accountable for, and the new requests addressed to
// the user's teams.

/** A request's URL on the install: the install's URL, a slash and the request's key, such as https://tiehall.example.com/FE-142. */
export const REQUEST_URL = new RegExp(`${INSTALL_URL.source.slice(0, -1)}/${REQUEST_KEY.source.slice(1, -1)}$`);

/** The request an update is about, in Tiehall's own words: its key, its target team and its URL on the install. */
export const updateRequest = z.object({
  id: z.uuid(),
  key: requestKeyOutput.meta({ description: "The request's key now, such as FE-142." }),
  url: z.string().regex(REQUEST_URL).meta({ description: "The request's URL on the install, which get_request and `tiehall get` read." }),
  targetTeam: teamRef.meta({ description: "The team the request is addressed to now." }),
});

/** An update: a domain event on a request in the reader's scope, with the request it is about. */
export const update = eventView.extend({ request: updateRequest });

/** A reader's cursor: the number of the last event it acknowledged, 0 before the first. */
const cursor = z.number().int().min(0).meta({ description: "The number of the last update this reader acknowledged; 0 before the first." });

/** How a pull reader answers: a page of updates, the requests they are about, the reader's cursor, and whether more wait. */
export const updatesPage = z.object({
  events: z.array(update).meta({ description: "The updates after your cursor, oldest first." }),
  // The key is quoted, so the source-citation check does not take the name and its colon for a citation of the capability.
  "requests": z.array(request).meta({ description: "The requests these updates are about, as they are now." }),
  cursor,
  more: z.boolean().meta({ description: "Whether more updates wait after this page; acknowledge this page to read them." }),
});

/** What a pull reader takes: the update to acknowledge first, and how many updates to return. */
export const updatesInput = z.object({
  acknowledge: z
    .number()
    .int()
    .min(0)
    .optional()
    .meta({
      description:
        "The number of the last update you have handled: your cursor moves up to it before the read, so the updates you get follow it. A cursor never moves back.",
    }),
  limit: z.coerce.number().int().min(1).max(50).optional().meta({ description: "How many updates to return, 1 to 50; 25 unless given." }),
});

export const readUpdates = defineCommand({
  id: "updates.read",
  summary:
    "Read your updates: the events after your cursor on the requests you opened, claimed or are accountable for, and the new requests addressed to your teams, oldest first. Nothing moves until you acknowledge: pass the number of the last update you handled, and the updates you get follow it. Each of your clients keeps its own place.",
  input: updatesInput,
  output: updatesPage,
  method: "POST",
  path: "/api/v1/updates",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp", "cli"],
  tool: "whats_new",
  cli: [{ command: "updates" }],
  stability: "alpha",
});

/**
 * An entry of the wait's answer (requester-loop: The long-poll wait endpoint;
 * design.md, Technical decisions: T15): ids and Tiehall's own text only, never
 * what anyone wrote, since it can reach a model unasked through the Claude
 * Code hooks (agent-safety: Notices that can reach a model carry only server
 * text). The reader then pulls the content with whats_new and get_request.
 */
export const waitEntry = z.object({
  seq: z.number().int().min(1).meta({ description: "The update's number, which whats_new acknowledges." }),
  type: z.string().regex(EVENT_TYPE_NAME).meta({ description: "The update's type, such as request.message_posted." }),
  request_key: requestKeyOutput.meta({ description: "The request's key, such as FE-142." }),
  team_key: z.string().regex(TEAM_KEY).meta({ description: "The key of the team the request is addressed to, such as FE." }),
  url: z.string().regex(REQUEST_URL).meta({ description: "The request's URL on the install." }),
});

export const waitForEvents = defineCommand({
  id: "events.wait",
  summary:
    "Wait for your next updates: answers as soon as one of the updates whats_new returns comes after the cursor, with ids and Tiehall's own text only, or with an empty list once 60 seconds pass. It moves no cursor: read the updates themselves with whats_new.",
  input: z.object({
    cursor: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .meta({ description: "The number of the last update you know of; the wait answers with the updates after it. Your client's cursor unless given." }),
  }),
  output: z.object({
    events: z.array(waitEntry).meta({ description: "The updates after the cursor, oldest first; empty when none came before the wait ended." }),
    cursor: z.number().int().min(0).meta({ description: "The number of the last update in the list, or the cursor the wait was given when the list is empty." }),
  }),
  method: "GET",
  path: "/api/v1/events/wait",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const UPDATE_COMMANDS = [readUpdates, waitForEvents];
