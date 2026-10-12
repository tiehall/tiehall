import { editMessage, getMessage, postMessage } from "@tiehall/catalog";
import {
  FLIPS_PER_DAY,
  formatRequestKey,
  messageEdited,
  messagePosted,
  Refusal,
  requestStateChanged,
  startsCountedFlip,
  utcDay,
  type RequestLifecycle,
} from "@tiehall/core";
import { messages, messageVersions, teams } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import { appendEvent } from "./append-event.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { recordHumanAction } from "./loop-limit.ts";
import { emailQuestion } from "./question-emails.ts";
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
import type { Writer } from "./write.ts";

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
// A message is recorded for the side its poster speaks for, as the team in
// its provenance, which the server decides when it is posted (requests: The
// side a message is posted for; findings-from-claude-code-run: design.md,
// Findings: F4 (7); design.md, Technical decisions: T5): the claimant, while a
// member of the target team, posts for the target team; otherwise as
// teamActedFor() decides for every write. An edit keeps the side, and a
// question is asked of the other side (question-emails.ts).
//
// Posting and editing are writes on the request, which the loop limit counts
// for an agent (agent-safety: Runaway agent loops flag the request
// needs_human); a message posted from a web session is a human action, which
// clears the request's flag and both of its counts.
//
// The flip limit (agent-safety: A request flips between needs_info and
// in_progress at most 3 times a day): an agent's blocking question on a
// request that is in_progress starts a counted flip on the UTC day it is
// posted, which the question records. When the request has made 3 counted
// flips that day, the question is posted as non-blocking instead, the request
// stays in_progress, and Tiehall adds a notice to the thread in its own words,
// recorded with the actor kind system.

/** The question an answer names, on the request it is posted on; 404 when there is none. */
/** How many counted flips the request started on a UTC day. */
async function countedFlipsOn({ tx, orgId }: OrgContext, requestId: string, day: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.requestId, requestId), eq(messages.countedFlipOn, day)));
  return row?.count ?? 0;
}

/** The next number in the request's thread. */
async function nextMessageNumber({ tx, orgId }: OrgContext, requestId: string): Promise<number> {
  const [placed] = await tx
    .select({ number: sql<number>`coalesce(max(${messages.number}), 0)::int + 1` })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.requestId, requestId)));
  return placed?.number ?? 1;
}

/**
 * Adds a message in Tiehall's own words to the request's thread, such as a
 * notice or the system message of a contract update: a comment recorded with
 * the actor kind system, with its own event. A write the system makes, such
 * as one that follows a signed contract report, records it with its own
 * provenance, the surface included; a write of a caller's own change that
 * leads Tiehall to add a notice, such as the flip limit's, names the system
 * as the notice's author instead. Tiehall's own messages are not posted by a
 * caller, so no side rule limits them; the caller has locked the request's
 * row.
 */
export async function addSystemMessage(writer: Writer, requestId: string, body: string, provenance?: { actorKind: "system"; surface?: "github" | "jira" }): Promise<string> {
  const author = provenance ?? writer.provenance;
  if (author.actorKind !== "system") throw new Error("Tiehall's own messages are recorded as the system's.");
  const { tx, orgId } = writer;
  const [message] = await tx
    .insert(messages)
    .values({
      orgId,
      requestId,
      number: await nextMessageNumber(writer, requestId),
      kind: "comment",
      blocking: false,
      actorKind: "system",
      surface: "surface" in author ? (author.surface ?? null) : null,
    })
    .returning({ id: messages.id });
  if (message === undefined) throw new Error("The system message was not returned.");
  await tx.insert(messageVersions).values({ orgId, messageId: message.id, version: 1, body });
  const data = { requestId, messageId: message.id, kind: "comment" as const, blocking: false };
  if (provenance === undefined) await writer.record(messagePosted, data);
  else await appendEvent(writer, messagePosted, data, provenance);
  return message.id;
}

/** Tiehall's notice that an agent's blocking question on the request with this key was posted as non-blocking. */
export function flipNoticeText(key: string): string {
  return (
    `Tiehall posted the question above as non-blocking: agents have already moved ${key} from in_progress to needs_info and back ` +
    `${FLIPS_PER_DAY} times today (UTC). A blocking question posted from the web UI still moves it to needs_info.`
  );
}

/** Adds Tiehall's notice that an agent's blocking question was posted as non-blocking, with its own event. */
async function addFlipNotice(writer: Writer, requestId: string, targetTeamId: string, number: number): Promise<void> {
  const { tx, orgId } = writer;
  const [team] = await tx.select({ key: teams.key }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.id, targetTeamId)));
  await addSystemMessage(writer, requestId, flipNoticeText(formatRequestKey(team?.key ?? "", number)), { actorKind: "system" });
}

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
    let blocking = input.kind === "question" && input.blocking === true;
    const questionId = input.kind === "answer" ? input.questionId : undefined;
    const day = utcDay(context.now());
    const startsFlip = startsCountedFlip({ actorKind: context.provenance.actorKind, blocking, state: current.state });
    const overFlipLimit = startsFlip && (await countedFlipsOn(context, row.id, day)) >= FLIPS_PER_DAY;
    if (overFlipLimit) blocking = false;
    let next: RequestLifecycle = current;
    if (blocking) next = transition(current, { kind: "ask_blocking" });
    if (questionId !== undefined) {
      const question = await questionOf(context, row.id, questionId);
      if (question.blocking && !question.answered) next = transition(current, { kind: "answer_blocking" });
    }
    const teamId = await teamActedFor(context, userId, row, "message");
    const stamp = stampOf(context.provenance, teamId);
    return context.write(async (writer) => {
      await writer.changesRequest(row.id);
      const { tx, orgId } = writer;
      const [posted] = await tx
        .insert(messages)
        .values({
          orgId,
          requestId: row.id,
          number: await nextMessageNumber(writer, row.id),
          kind: input.kind,
          blocking,
          questionId: questionId ?? null,
          countedFlipOn: startsFlip && !overFlipLimit ? day : null,
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
      // A question is emailed at once to the person it is asked of, when SMTP is set (question-emails.ts).
      if (input.kind === "question") await writer.enqueue(emailQuestion.type, { messageId: posted.id });
      if (overFlipLimit) await addFlipNotice(writer, row.id, row.targetTeamId, row.number);
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
    // Edits of the thread's messages run one after the other, so each takes the next version. An edit keeps the
    // side the message was posted for (requests: The side a message is posted for).
    await lockRequestById(context, row.requestId);
    const teamId = row.teamId ?? undefined;
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
