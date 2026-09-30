import { z } from "zod";
import { defineCommand } from "./command.ts";
import { PACKET_KINDS } from "./packet.ts";
import { PACKET_FIELD_NAME } from "./packets.ts";
import { message, request, requestKey, teamRef } from "./requests.ts";

// Reading a request by key, in pages, for agents (agent-surfaces: Reading a
// request by key or URL, in pages; agent-surfaces: The MCP tools; design.md,
// Decisions this change rests on: D28 #69). The MCP tool get_request reads a
// request with its packet and its thread, as a page: the request as the other
// operations return it, needs_human included, the facts Tiehall states about
// its current packet revision, and the parts of the packet and the thread the
// page holds, each part the text of one packet field or one message, whole or
// in parts. Text a user wrote sits under `untrusted`, as a part's text (a
// packet field that is not text, such as the links, is its JSON), apart from
// the ids, keys and values Tiehall states (agent-safety: User text in JSON sits
// under untrusted objects). A page names its place among the pages and what to
// read next, none once it is the last.

/** The sections of a request that a page reads: its packet and its thread; all of them unless one is named. */
export const REQUEST_SECTIONS = ["packet", "thread"] as const;

/** Which sections a page reads: all of them, or one. */
const pageSection = z.enum(["all", ...REQUEST_SECTIONS]);

/** Where a part sits among the parts of one packet field or one message, which a long text is split into. */
const partPlace = {
  part: z.number().int().min(1).meta({ description: "This part's number, from 1." }),
  parts: z.number().int().min(1).meta({ description: "How many parts the field or message is split into; 1 when it is whole." }),
};

/** One part of a page: the text of one packet field, or of one message, whole or in parts. */
const pagePart = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("packet_field"),
    field: z.string().regex(PACKET_FIELD_NAME).meta({ description: "The packet field, such as need or acceptance_criteria." }),
    ...partPlace,
    untrusted: z.object({
      text: z.string().meta({ description: "The field's text, or, for a field that is not text, its JSON: all of it, or this part." }),
    }),
  }),
  z.object({
    kind: z.literal("message"),
    message: message.omit({ untrusted: true }).meta({ description: "The message of the thread: its kind, what it answers, when it was posted and who posted it." }),
    ...partPlace,
    untrusted: z.object({
      text: z.string().meta({ description: "The message's latest text: all of it, or this part." }),
      client: z.string().nullable().meta({ description: "The agent client its poster named themselves by." }),
    }),
  }),
]);

/** A page of a request, as get_request returns it. */
export const requestPage = z.object({
  request,
  /** What Tiehall states about the request's current packet revision. */
  packet: z.object({
    revision: z.number().int().min(1).meta({ description: "The current revision's number, from 1 for the packet the request was opened with." }),
    kind: z.enum(PACKET_KINDS),
    dueDate: z.iso.date().nullable().meta({ description: "The day the request is due, from the current revision; null when it names none." }),
    team: teamRef.nullable().meta({ description: "The team whose member added the current revision; null for a revision Tiehall added." }),
  }),
  section: pageSection.meta({ description: "The sections this page reads: all, or the one named." }),
  page: z.number().int().min(1),
  pages: z.number().int().min(1).meta({ description: "How many pages the sections read take." }),
  next: z
    .object({ section: pageSection, page: z.number().int().min(1) })
    .nullable()
    .meta({ description: "The section and page to read next; null on the last page." }),
  parts: z.array(pagePart),
});

export const readRequest = defineCommand({
  id: "requests.read",
  summary:
    "Read a request by its key, such as FE-142, with its packet and its thread, as a page that shows whether the request waits for a person (needs_human). Every member of the install can read every request.",
  input: z.object({
    request: requestKey,
  }),
  output: requestPage,
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["mcp"],
  tool: "get_request",
  stability: "alpha",
});

export const REQUEST_PAGE_COMMANDS = [readRequest];
