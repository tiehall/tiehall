import type { message, request } from "@tiehall/catalog";
import { formatRequestKey, Refusal, type RequestState } from "@tiehall/core";
import { messages, messageVersions, requests, teams, users } from "@tiehall/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { noSuchRequest } from "./request-keys.ts";
import type { OrgContext } from "./with-org.ts";

// Requests and their threads as the operations return them (requests: Every
// member sees every request; requests: Thread messages and blocking
// questions; requests: Provenance is stamped by the server; agent-safety: User
// text in JSON sits under untrusted objects). A request carries its key,
// written with its target team's current key, its state, its teams and the
// users it names, each marked with their kind and bot flag; its title sits
// under `untrusted`. A message carries its kind, what it answers or whether it
// was answered, its provenance, and its latest version's text under
// `untrusted`, with the client its poster named themselves by.

/** A request as the operations return it. */
export type RequestView = z.input<typeof request>;
/** A message as the operations return it. */
export type MessageView = z.input<typeof message>;

export type RequestRow = typeof requests.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** Users by id, as outputs name them. */
async function usersById({ tx, orgId }: OrgContext, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const rows =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: users.id, login: users.githubLogin, bot: users.bot })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(users.id, wanted)));
  const byId = new Map(rows.map(({ id, login, bot }) => [id, { id, login, kind: "human" as const, bot }]));
  return (id: string | null) => (id === null ? null : (byId.get(id) ?? null));
}

/** Teams by id, as outputs name them: their id and current key. */
async function teamsById({ tx, orgId }: OrgContext, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const rows =
    wanted.length === 0
      ? []
      : await tx.select({ id: teams.id, key: teams.key }).from(teams).where(and(eq(teams.orgId, orgId), inArray(teams.id, wanted)));
  const byId = new Map(rows.map((team) => [team.id, team]));
  return (id: string) => {
    const team = byId.get(id);
    if (team === undefined) throw new Error("A record names a team the install does not have.");
    return team;
  };
}

/** Requests as the operations return them, in the order of the rows. */
export async function requestViews(context: OrgContext, rows: readonly RequestRow[]): Promise<RequestView[]> {
  const teamOf = await teamsById(context, rows.flatMap((row) => [row.targetTeamId, row.requestingTeamId]));
  const userOf = await usersById(context, rows.flatMap((row) => [row.requestingUserId, row.claimantUserId]));
  return rows.map((row) => {
    const target = teamOf(row.targetTeamId);
    return {
      id: row.id,
      key: formatRequestKey(target.key, row.number),
      state: row.state as RequestState,
      targetTeam: target,
      requester: { user: userOf(row.requestingUserId), team: teamOf(row.requestingTeamId) },
      claimant: userOf(row.claimantUserId),
      createdAt: row.createdAt.toISOString(),
      needsHuman: row.needsHuman,
      untrusted: { title: row.title },
    };
  });
}

/** One request as the operations return it; 404 when the install has no such request. */
export async function requestView(context: OrgContext, requestId: string): Promise<RequestView> {
  const rows = await context.tx
    .select()
    .from(requests)
    .where(and(eq(requests.orgId, context.orgId), eq(requests.id, requestId)));
  const [view] = await requestViews(context, rows);
  if (view === undefined) throw noSuchRequest();
  return view;
}

/** Messages as the operations return them, each with its latest version, in the order of the rows. */
export async function messageViews(context: OrgContext, rows: readonly MessageRow[]): Promise<MessageView[]> {
  const { tx, orgId } = context;
  const ids = rows.map(({ id }) => id);
  const latest =
    ids.length === 0
      ? []
      : await tx
          .selectDistinctOn([messageVersions.messageId], {
            messageId: messageVersions.messageId,
            version: messageVersions.version,
            body: messageVersions.body,
            createdAt: messageVersions.createdAt,
          })
          .from(messageVersions)
          .where(and(eq(messageVersions.orgId, orgId), inArray(messageVersions.messageId, ids)))
          .orderBy(messageVersions.messageId, desc(messageVersions.version));
  const answeredIds =
    ids.length === 0
      ? []
      : await tx
          .selectDistinct({ questionId: messages.questionId })
          .from(messages)
          .where(and(eq(messages.orgId, orgId), inArray(messages.questionId, ids)));
  const latestOf = new Map(latest.map((version) => [version.messageId, version]));
  const answered = new Set(answeredIds.map(({ questionId }) => questionId));
  const userOf = await usersById(context, rows.map(({ actorUserId }) => actorUserId));
  const teamOf = await teamsById(context, rows.map(({ teamId }) => teamId));
  return rows.map((row) => {
    const version = latestOf.get(row.id);
    if (version === undefined) throw new Error("A message has no version.");
    return {
      id: row.id,
      kind: row.kind as MessageView["kind"],
      blocking: row.blocking,
      questionId: row.questionId,
      answered: row.kind === "question" ? answered.has(row.id) : null,
      version: version.version,
      postedAt: row.postedAt.toISOString(),
      editedAt: version.version > 1 ? version.createdAt.toISOString() : null,
      provenance: {
        actorKind: row.actorKind as MessageView["provenance"]["actorKind"],
        surface: row.surface as MessageView["provenance"]["surface"],
        user: userOf(row.actorUserId),
        team: row.teamId === null ? null : teamOf(row.teamId),
      },
      untrusted: { body: version.body, client: row.client },
    };
  });
}

/** Refused as a record that does not exist. */
export function noSuchMessage(): Refusal {
  return new Refusal("record-not-found", "There is no such message.");
}

/** A message's row; 404 when the install has no such message. */
export async function messageRowOf({ tx, orgId }: OrgContext, messageId: string): Promise<MessageRow> {
  const [row] = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  if (row === undefined) throw noSuchMessage();
  return row;
}

/** One message as the operations return it; 404 when the install has no such message. */
export async function messageView(context: OrgContext, messageId: string): Promise<MessageView> {
  const [view] = await messageViews(context, [await messageRowOf(context, messageId)]);
  if (view === undefined) throw noSuchMessage();
  return view;
}

/** Every version of a message's text, oldest first. */
export async function versionsOf({ tx, orgId }: OrgContext, messageId: string) {
  const rows = await tx
    .select({ version: messageVersions.version, createdAt: messageVersions.createdAt, body: messageVersions.body })
    .from(messageVersions)
    .where(and(eq(messageVersions.orgId, orgId), eq(messageVersions.messageId, messageId)))
    .orderBy(asc(messageVersions.version));
  return rows.map(({ version, createdAt, body }) => ({ version, createdAt: createdAt.toISOString(), untrusted: { body } }));
}

/** A request's thread, oldest message first. */
export async function threadOf(context: OrgContext, requestId: string): Promise<MessageView[]> {
  const rows = await context.tx
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, context.orgId), eq(messages.requestId, requestId)))
    .orderBy(asc(messages.number));
  return messageViews(context, rows);
}

/** How many blocking questions on the request have no answer yet. */
export async function openBlockingQuestionsOf({ tx, orgId }: OrgContext, requestId: string): Promise<number> {
  const { rows } = await tx.execute<{ open: number }>(sql`
    SELECT count(*)::int AS open FROM ${messages} q
     WHERE q.org_id = ${orgId} AND q.request_id = ${requestId} AND q.kind = 'question' AND q.blocking
       AND NOT EXISTS (SELECT 1 FROM ${messages} a WHERE a.org_id = q.org_id AND a.question_id = q.id)`);
  return Number(rows[0]?.open ?? 0);
}
