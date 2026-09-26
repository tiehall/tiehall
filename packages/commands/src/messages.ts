import { editMessage, getMessage, postMessage } from "@tiehall/catalog";
import { messageEdited, messagePosted, Refusal, requestStateChanged, type RequestLifecycle } from "@tiehall/core";
import { messages, messageVersions } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { recordHumanAction } from "./loop-limit.ts";
import {
  actingUserOf,
  assertSideAllows,
  lifecycleOf,
  lockRequest,
  lockRequestById,
  saveLifecycle,
  stampOf,
  teamActedFor,
  transition,
} from "./request-changes.ts";
import { messageRowOf, messageView, requestView, versionsOf } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// A request's thread (requests: Thread messages and blocking questions;
// requests: Requests only, with questions in the request's thread; requests:
// Provenance is stamped by the server; requests: Events carry ids, not
// bodies; design.md, Decisions this change rests on: D11, D28 #3, #17;
// design.md, Readings to confirm with the founder: R14). A message is posted on
// a request, never anywhere else, and only by its two sides: the requester
// side and the members of its target team; anyone else gets 403 and nothing is
// added. A comment or a non-blocking question changes no state, also on a
// request that has ended. A blocking question moves an open, claimed or
// in_progress request to needs_info, and a request that has ended refuses one
// with 409. An answer names a question of the same request, or gets 404; the
// first answer to a blocking question counts toward returning the request to
// the state it had, once every blocking question has one. The message, its
// first version, the state it changes and their events commit together; the
// events name the message, never its text.
//
// Messages are append-only (requests: Messages are append-only): only its
// author edits a message, and an edit adds its next version, with an event
// that names the version; nothing ever changes or removes an earlier version,
// which the database also refuses (migration 0017).
//
// Posting and editing are writes on the request, which the loop limit counts
// for an agent (agent-safety: Runaway agent loops flag the request
// needs_human); a message posted from a web session is a human action, which
// clears the request's flag and both of its counts.

/** The question an answer names, on the request it is posted on; 404 when there is none. */
async function questionOf({ tx, orgId }: OrgContext, requestId: string, questionId: string) {
  const [question] = await tx
    .select({ id: messages.id, blocking: messages.blocking })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.requestId, requestId), eq(messages.id, questionId), eq(messages.kind, "question")));
  if (question === undefined) throw new Refusal("record-not-found", "There is no such question on this request.");
  const [answer] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.questionId, questionId)))
    .limit(1);
  return { ...question, answered: answer !== undefined };
}

export const MESSAGE_HANDLERS: Handlers = {
  [postMessage.id]: defineHandler(postMessage, async (input, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, input.key);
    await assertSideAllows(context, userId, row, "post_message");
    const current = await lifecycleOf(context, row);
    const blocking = input.kind === "question" && input.blocking === true;
    const questionId = input.kind === "answer" ? input.questionId : undefined;
    let next: RequestLifecycle = current;
    if (blocking) next = transition(current, { kind: "ask_blocking" });
    if (questionId !== undefined) {
      const question = await questionOf(context, row.id, questionId);
      if (question.blocking && !question.answered) next = transition(current, { kind: "answer_blocking" });
    }
    const teamId = await teamActedFor(context, userId, row);
    const stamp = stampOf(context.provenance, teamId);
    return context.write(async (writer) => {
      await writer.changesRequest(row.id);
      const { tx, orgId } = writer;
      const [placed] = await tx
        .select({ number: sql<number>`coalesce(max(${messages.number}), 0)::int + 1` })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), eq(messages.requestId, row.id)));
      const [posted] = await tx
        .insert(messages)
        .values({
          orgId,
          requestId: row.id,
          number: placed?.number ?? 1,
          kind: input.kind,
          blocking,
          questionId: questionId ?? null,
          ...stamp,
        })
        .returning({ id: messages.id });
      if (posted === undefined) throw new Error("The new message was not returned.");
      await tx.insert(messageVersions).values({ orgId, messageId: posted.id, version: 1, body: input.body });
      await writer.record(messagePosted, {
        requestId: row.id,
        messageId: posted.id,
        kind: input.kind,
        blocking,
        ...(questionId === undefined ? {} : { questionId }),
      });
      if (next.state !== current.state) {
        await writer.record(requestStateChanged, { requestId: row.id, state: next.state, previousState: current.state });
      }
      if (next !== current) await saveLifecycle(writer, row.id, next);
      if (writer.provenance.actorKind === "web_session") await recordHumanAction(writer, row.id);
      return { message: await messageView(writer, posted.id), request: await requestView(writer, row.id) };
    }, { teamId });
  }),

  [getMessage.id]: defineHandler(getMessage, async ({ messageId }, context) => {
    const view = await messageView(context, messageId);
    const row = await messageRowOf(context, messageId);
    const { id, key, targetTeam } = await requestView(context, row.requestId);
    return { ...view, request: { id, key, targetTeam }, versions: await versionsOf(context, messageId) };
  }),

  [editMessage.id]: defineHandler(editMessage, async ({ messageId, body }, context) => {
    const userId = actingUserOf(context);
    const row = await messageRowOf(context, messageId);
    if (row.actorUserId !== userId) throw new Refusal("forbidden", "Only the author of a message may edit it.");
    // Edits of the thread's messages run one after the other, so each takes the next version.
    const request = await lockRequestById(context, row.requestId);
    const teamId = await teamActedFor(context, userId, request);
    return context.write(async (writer) => {
      await writer.changesRequest(row.requestId);
      const [latest] = await writer.tx
        .select({ version: sql<number>`max(${messageVersions.version})::int` })
        .from(messageVersions)
        .where(and(eq(messageVersions.orgId, writer.orgId), eq(messageVersions.messageId, messageId)));
      const version = (latest?.version ?? 0) + 1;
      await writer.tx.insert(messageVersions).values({ orgId: writer.orgId, messageId, version, body });
      await writer.record(messageEdited, { requestId: row.requestId, messageId, version });
      return messageView(writer, messageId);
    }, { teamId });
  }),
};
