import { claimRequest, createRequest, getRequest, listRequests, setRequestStatus, type request } from "@tiehall/catalog";
import {
  changeRequest,
  formatRequestKey,
  Refusal,
  requestClaimed,
  requestOpened,
  requestReleased,
  requestStarted,
  sideAllows,
  whoMay,
  type RequestAction,
  type RequestChange,
  type RequestLifecycle,
  type RequestParties,
  type RequestState,
  type ResumableState,
} from "@tiehall/core";
import { requests, teams, users } from "@tiehall/db";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { memberOf, teamsOfMember, type MemberTeam } from "./members.ts";
import { noSuchRequest, resolveRequestKey, teamOfKey } from "./request-keys.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import type { OrgContext } from "./with-org.ts";

// The request operations (requests: A request is addressed to a team of the
// install; requests: The requester picks the requesting team; requests:
// Request states; requests: Per-team request keys; requests: The event log;
// design.md, Decisions this change rests on: D25, D28 #11; design.md,
// Readings to confirm with the founder: R14).
//
// Reading: every member sees every request, whichever teams they belong to, so
// the reads check no side. A key written with a team's earlier key names the
// same request, which comes back under its current key.
//
// Changing a request: each change locks the request's row first, so changes
// to one request run one after the other. The caller's side must allow the
// action, or it gets 403 (the side rules in packages/core), and then the
// request's state must allow the change, or it gets 409 (the state machine in
// packages/core); either refusal changes nothing. Claiming, starting work and
// releasing a claim need no proposal: the change and its event commit
// together.
//
// Opening a request: it is addressed to one team of the install, and a team
// the install does not have gets 404. The requester picks the team they open
// it from among their own: their only team is the default; a member of
// several teams who names none gets 400, which lists the teams to pick from; a
// member of no team, and one who names a team they are not in, gets 403. The
// request starts open with the next number of its target team, and the
// request, its number and its event commit together or not at all.

/** A request as the operations return it. */
export type RequestView = z.input<typeof request>;

/** The user a call acts for. The request operations run only for a caller that acts for a user. */
export function actingUserOf(context: HandlerContext): string {
  const userId = context.member?.userId;
  if (userId === undefined) throw new Error("A request operation runs only for a caller that acts for a user.");
  return userId;
}

/** "BE", "BE and QA", or "BE, OPS and QA". */
function listed(keys: readonly string[]): string {
  return keys.length <= 2 ? keys.join(" and ") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

/** The team the user opens a request from: the one they name, which must be theirs, or their only team. */
async function requestingTeamOf(context: HandlerContext, userId: string, named: string | undefined): Promise<MemberTeam> {
  const mine = await teamsOfMember(context, userId);
  if (named !== undefined) {
    const team = await teamOfKey(context, named);
    const own = team === undefined ? undefined : mine.find(({ id }) => id === team.id);
    if (own === undefined) throw new Refusal("forbidden", "You can open a request only from a team you belong to.");
    return own;
  }
  const [only, ...others] = mine;
  if (only === undefined) {
    throw new Refusal("forbidden", "You belong to no team, so you cannot open a request until an admin adds you to one.");
  }
  if (others.length > 0) {
    const keys = mine.map(({ key }) => key);
    throw new Refusal("invalid-input", `You belong to ${listed(keys)}; name the team you open the request from as requestingTeam.`, {
      issues: [{ path: ["requestingTeam"], message: `Name one of your teams: ${keys.join(", ")}.` }],
    });
  }
  return only;
}

type RequestRow = typeof requests.$inferSelect;

/** Requests as the operations return them, with the teams and users they name, in the order of the rows. */
export async function requestViews({ tx, orgId }: OrgContext, rows: readonly RequestRow[]): Promise<RequestView[]> {
  const teamIds = [...new Set(rows.flatMap((row) => [row.targetTeamId, row.requestingTeamId]))];
  const userIds = [...new Set(rows.flatMap((row) => [row.requestingUserId, row.claimantUserId]).filter((id): id is string => id !== null))];
  const teamRows =
    teamIds.length === 0
      ? []
      : await tx.select({ id: teams.id, key: teams.key }).from(teams).where(and(eq(teams.orgId, orgId), inArray(teams.id, teamIds)));
  const userRows =
    userIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, login: users.githubLogin, bot: users.bot })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)));
  const teamById = new Map(teamRows.map((team) => [team.id, team]));
  const userById = new Map(userRows.map(({ id, login, bot }) => [id, { id, login, kind: "human" as const, bot }]));
  const teamOf = (id: string) => {
    const team = teamById.get(id);
    if (team === undefined) throw new Error("A request names a team the install does not have.");
    return team;
  };
  const userOf = (id: string | null) => (id === null ? null : (userById.get(id) ?? null));
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

/** The request a key names, with its row locked until the call's transaction ends; 404 when the key names none. */
async function lockRequest(context: OrgContext, key: string): Promise<RequestRow> {
  const { requestId } = await resolveRequestKey(context, key);
  const [row] = await context.tx
    .select()
    .from(requests)
    .where(and(eq(requests.orgId, context.orgId), eq(requests.id, requestId)))
    .for("update");
  if (row === undefined) throw noSuchRequest();
  return row;
}

/** Who the request's parties are, as the side rules see them, with whether its claimant is still a member. */
async function partiesOf(context: OrgContext, row: RequestRow): Promise<RequestParties> {
  const claimantIsMember = row.claimantUserId !== null && (await memberOf(context, row.claimantUserId)) !== undefined;
  return {
    targetTeamId: row.targetTeamId,
    requestingTeamId: row.requestingTeamId,
    requestingUserId: row.requestingUserId,
    claimantId: row.claimantUserId,
    claimantIsMember,
  };
}

/** Refuses, with 403, an action the user's side of the request does not allow. */
async function assertSideAllows(context: OrgContext, userId: string, row: RequestRow, action: RequestAction): Promise<void> {
  const teamIds = (await teamsOfMember(context, userId)).map(({ id }) => id);
  if (!sideAllows({ userId, teamIds }, await partiesOf(context, row), action)) throw new Refusal("forbidden", whoMay(action));
}

/** Where the request is in its lifecycle, as the state machine sees it. */
function lifecycleOf(row: RequestRow, openBlockingQuestions: number): RequestLifecycle {
  return {
    state: row.state as RequestState,
    claimantId: row.claimantUserId,
    resumeState: row.resumeState as ResumableState | null,
    openBlockingQuestions,
  };
}

/** Where the change takes the request; 409 when its state does not allow it. */
function transition(current: RequestLifecycle, change: RequestChange): RequestLifecycle {
  const result = changeRequest(current, change);
  if (!result.ok) throw new Refusal("conflict", result.conflict);
  return result.next;
}

/** Stores where the request is now in its lifecycle. */
async function saveLifecycle({ tx, orgId }: OrgContext, requestId: string, next: RequestLifecycle): Promise<void> {
  await tx
    .update(requests)
    .set({ state: next.state, claimantUserId: next.claimantId, resumeState: next.resumeState })
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
}

export const REQUEST_HANDLERS: Handlers = {
  [createRequest.id]: defineHandler(createRequest, async ({ targetTeam, requestingTeam, title }, context) => {
    const userId = actingUserOf(context);
    const target = await teamOfKey(context, targetTeam);
    if (target === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const from = await requestingTeamOf(context, userId, requestingTeam);
    return context.write(async (writer) => {
      const number = await takeRequestNumber(writer, target.id);
      const [row] = await writer.tx
        .insert(requests)
        .values({ orgId: writer.orgId, targetTeamId: target.id, number, title, requestingUserId: userId, requestingTeamId: from.id })
        .returning({ id: requests.id });
      if (row === undefined) throw new Error("The new request was not returned.");
      await writer.record(requestOpened, { requestId: row.id, targetTeamId: target.id, requestingTeamId: from.id });
      return requestView(writer, row.id);
    });
  }),

  [getRequest.id]: defineHandler(getRequest, async ({ key }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return requestView(context, requestId);
  }),

  [listRequests.id]: defineHandler(listRequests, async ({ targetTeam, state, limit, offset }, context) => {
    const where: SQL[] = [eq(requests.orgId, context.orgId)];
    if (targetTeam !== undefined) {
      const team = await teamOfKey(context, targetTeam);
      if (team === undefined) throw new Refusal("record-not-found", "There is no such team.");
      where.push(eq(requests.targetTeamId, team.id));
    }
    if (state !== undefined) where.push(eq(requests.state, state));
    const rows = await context.tx
      .select()
      .from(requests)
      .where(and(...where))
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(limit ?? 50)
      .offset(offset ?? 0);
    return { "requests": await requestViews(context, rows) };
  }),

  [claimRequest.id]: defineHandler(claimRequest, async ({ key }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    await assertSideAllows(context, userId, row, "claim");
    // Blocking questions come with the thread; until then no request waits on one.
    const next = transition(lifecycleOf(row, 0), { kind: "claim", userId });
    return context.write(async (writer) => {
      await saveLifecycle(writer, row.id, next);
      await writer.record(requestClaimed, { requestId: row.id, userId });
      return requestView(writer, row.id);
    });
  }),

  [setRequestStatus.id]: defineHandler(setRequestStatus, async ({ key, state }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    const action = state === "open" ? "release" : "start";
    await assertSideAllows(context, userId, row, action);
    const current = lifecycleOf(row, 0);
    const next = transition(current, { kind: action });
    return context.write(async (writer) => {
      await saveLifecycle(writer, row.id, next);
      if (action === "release" && current.claimantId !== null) {
        await writer.record(requestReleased, { requestId: row.id, userId: current.claimantId });
      } else {
        await writer.record(requestStarted, { requestId: row.id });
      }
      return requestView(writer, row.id);
    });
  }),
};
