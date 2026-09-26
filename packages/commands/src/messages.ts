import { postMessage } from "@tiehall/catalog";
import { messagePosted, Refusal, requestStateChanged, type RequestLifecycle } from "@tiehall/core";
import { messages, messageVersions } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import { provenanceOf } from "./caller.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { actingUserOf, assertSideAllows, lifecycleOf, lockRequest, saveLifecycle, transition } from "./request-changes.ts";
import { messageView, requestView } from "./request-views.ts";
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

/** The provenance columns of a message, stamped from the caller. */
function stampOf(caller: HandlerContext["caller"]) {
  const provenance = provenanceOf(caller);
  if (provenance.actorKind === "operator") throw new Error("An operator command posts no message.");
  return {
    actorKind: provenance.actorKind,
    actorUserId: provenance.userId ?? null,
    client: provenance.client ?? null,
    surface: provenance.surface ?? null,
    teamId: provenance.teamId ?? null,
  };
}

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
    const stamp = stampOf(context.caller);
    return context.write(async (writer) => {
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
      return { message: await messageView(writer, posted.id), request: await requestView(writer, row.id) };
    });
  }),
};
