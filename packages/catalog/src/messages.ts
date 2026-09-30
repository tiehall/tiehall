import { z } from "zod";
import { defineCommand } from "./command.ts";
import { message, request, requestKey, requestRef, teamRef } from "./requests.ts";

// The operations on a request's thread (requests: Thread messages and blocking
// questions; requests: Requests only, with questions in the request's thread;
// requests: Provenance is stamped by the server; agent-surfaces: Tools that
// change a request directly). A message is a comment, a
// question, which may be blocking, or an answer, which names the question it
// answers; an answer without one fails the schema and gets 400. The kinds are
// strict variants, so a field of another kind, such as a comment that names a
// question, fails the schema too, on REST and on the post_message tool alike
// (agent-surfaces: Tool schemas that current clients accept). There is no
// thread outside a request, so every message is posted on one. Provenance is
// never part of the input: the server stamps it from the caller, and any key
// a payload sends for it is dropped with every other key the schema does not
// know. Text a user wrote sits under `untrusted`, and so does the client the
// caller names itself by (agent-safety: User text in JSON sits under untrusted
// objects).
//
// Messages are append-only (requests: Messages are append-only): its author
// edits a message by adding its next version, and every earlier version stays
// readable exactly as it was written.

/** A message's text, exactly as its author writes it: 1 to 65,536 characters, not all blank, with no NUL character. */
export const messageBody = z
  .string()
  .min(1)
  .max(65536)
  .regex(/^[^\u0000]*[^\s\u0000][^\u0000]*$/, "A message says something, is not blank, and holds no NUL character.")
  .meta({ description: "The message's text, as you write it; it is kept exactly." });

const noBlocking = z.literal(false).optional().meta({ description: "Only a question can block its request." });

export const postMessage = defineCommand({
  id: "messages.post",
  summary:
    "Post a comment, a question or an answer in a request's thread. A blocking question moves the request to needs_info until every blocking question has an answer; an answer names the question it answers.",
  input: z.discriminatedUnion("kind", [
    z.strictObject({ key: requestKey, kind: z.literal("comment"), body: messageBody, blocking: noBlocking }),
    z.strictObject({
      key: requestKey,
      kind: z.literal("question"),
      body: messageBody,
      blocking: z.boolean().optional().meta({ description: "Whether the request waits for the answer; false unless given." }),
    }),
    z.strictObject({
      key: requestKey,
      kind: z.literal("answer"),
      body: messageBody,
      questionId: z.uuid().meta({ description: "The id of the question this answers." }),
      blocking: noBlocking,
    }),
  ]),
  output: z.object({ message, request }),
  method: "POST",
  path: "/api/v1/requests/{key}/messages",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp"],
  tool: "post_message",
  stability: "alpha",
});

/** One version of a message's text. */
export const messageVersion = z.object({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  untrusted: z.object({ body: z.string() }),
});

/** A message with every version of its text, oldest first, and the request whose thread holds it. */
export const messageWithVersions = message.extend({
  request: requestRef.extend({ targetTeam: teamRef }),
  versions: z.array(messageVersion),
});

const messageId = z.uuid().meta({ description: "The message's id." });

export const getMessage = defineCommand({
  id: "messages.get",
  summary: "Read a message of a request's thread, with every version of its text.",
  input: z.object({ messageId }),
  output: messageWithVersions,
  method: "GET",
  path: "/api/v1/messages/{messageId}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const editMessage = defineCommand({
  id: "messages.edit",
  summary: "Edit a message you posted: its new text becomes its next version, and every earlier version stays as it was.",
  input: z.object({ messageId, body: messageBody }),
  output: message,
  method: "POST",
  path: "/api/v1/messages/{messageId}/versions",
  scopes: ["requests:write"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "alpha",
});

export const MESSAGE_COMMANDS = [postMessage, getMessage, editMessage];
