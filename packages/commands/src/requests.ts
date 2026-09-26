import { createRequest, type request } from "@tiehall/catalog";
import { formatRequestKey, Refusal, requestOpened, type RequestState } from "@tiehall/core";
import { requests, teams, users } from "@tiehall/db";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { teamsOfMember, type MemberTeam } from "./members.ts";
import { noSuchRequest, teamOfKey } from "./request-keys.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import type { OrgContext } from "./with-org.ts";

// The request operations (requests: A request is addressed to a team of the
// install; requests: The requester picks the requesting team; requests:
// Request states; requests: Per-team request keys; requests: The event log;
// design.md, Decisions this change rests on: D25, D28 #11; design.md,
// Readings to confirm with the founder: R14).
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
};
