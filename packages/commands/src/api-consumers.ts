import { declareConsumer, listTeamApis, reconfirmConsumer, removeConsumer, type consumerDeclaration } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { apiConsumerReconfirmationEmails, apiConsumers, apis, members, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { apiNameText, installLink, RECONFIRMATION_REQUEST, serverDay, teamKey } from "./email.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { actingUserOf } from "./request-changes.ts";
import { teamOfKey } from "./request-keys.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The consumer map (contract-changes: Teams declare the APIs they consume;
// teams-and-roles: What admins and members may do; design.md, Decisions this
// change rests on: D15, D28 #4, #72). A team declares that it consumes a
// registered API, on its page in the web UI. The declaration is the team's:
// any member of the team makes it or removes it, and anyone who is not a
// member of that team gets 403, whatever their role, before any API is looked
// up, so they learn nothing of it. A team that does not exist gets 404, as
// does an API; an unregistered API takes no declaration (409). A declaration
// records who made it and when, which is also when it was last confirmed;
// made again, it changes nothing. Declarations change no request, so they
// record no event; the activity log does not hold team changes in v1
// (design.md, Readings to confirm with the founder: R21).
//
// Routing reads the declarations alone (consumersOf): the teams that declared
// they consume an API, while it is registered, and no other team, whatever
// requests or history it has. A stale declaration routes like any other.
//
// Re-confirmation (contract-changes: Declarations are re-confirmed every 90
// days; requester-loop: The web inbox; self-host-install: Optional email
// through SMTP; design.md, Decisions this change rests on: D28 #61, #73;
// D29 (6)). Because the map is kept by hand, a daily job asks the consuming
// team to re-confirm each declaration of a registered API on the UTC day 90
// days after the UTC day it was last confirmed: a declaration last confirmed
// on 2026-10-01 is asked for on 2026-12-30, not on 2026-12-29, at the job's
// first run from that day on, so a worker that was stopped catches up. The
// request is listed in the standing list of the web inbox of each member of
// the team, while it waits, and, when SMTP is set, emailed once to each
// member of the team with an address, whatever their digest setting, since the
// digest switch stops the digests alone. Any member of the team re-confirms
// it, which moves its last confirmation to now, keeps its declarer, and ends
// the request; anyone else gets 403. A declaration left unconfirmed 30 more
// days, on the UTC day 120 days after the day of its last confirmation, is
// marked stale until it is re-confirmed, and keeps routing.

/** The UTC days after a declaration's last confirmation on which it is asked to be re-confirmed, and marked stale unless it is. */
export const RECONFIRM_AFTER_DAYS = 90;
export const STALE_AFTER_DAYS = 120;

/** The UTC day so many days after a time's own, as YYYY-MM-DD. */
function dayAfter(time: Date, days: number): string {
  const day = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()) + days * 86_400_000;
  return new Date(day).toISOString().slice(0, 10);
}

/** What a request to re-confirm a declaration says, in Tiehall's words. */
export function reconfirmationText(request: { team: string; api: string; lastConfirmedAt: Date; staleAt: Date | null }): string {
  const { team, api, lastConfirmedAt, staleAt } = request;
  const head = `${team} declared that it consumes ${api}, last confirmed on ${lastConfirmedAt.toISOString().slice(0, 10)}: re-confirm that ${team} still consumes it, or remove the declaration on ${team}'s page.`;
  return staleAt === null
    ? `${head} Unless a member of ${team} re-confirms it by ${dayAfter(lastConfirmedAt, STALE_AFTER_DAYS - 1)}, it is marked stale on ${dayAfter(lastConfirmedAt, STALE_AFTER_DAYS)}, and changes to it still reach ${team}.`
    : `${head} It is marked stale since ${staleAt.toISOString().slice(0, 10)}, and changes to it still reach ${team}.`;
}

type ConsumerDeclaration = z.input<typeof consumerDeclaration>;

/** The teams that declared they consume the API, while it is registered, by key; contract-change routing reads only these. */
export async function consumersOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, apiId: string): Promise<{ id: string; key: string }[]> {
  return tx
    .select({ id: teams.id, key: teams.key })
    .from(apiConsumers)
    .innerJoin(apis, and(eq(apis.orgId, apiConsumers.orgId), eq(apis.id, apiConsumers.apiId)))
    .innerJoin(teams, and(eq(teams.orgId, apiConsumers.orgId), eq(teams.id, apiConsumers.teamId)))
    .where(and(eq(apiConsumers.orgId, orgId), eq(apiConsumers.apiId, apiId), isNull(apis.unregisteredAt)))
    .orderBy(asc(teams.key));
}

/** Whether the user is a member of the team. */
async function inTeam({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string, teamId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row !== undefined;
}

/**
 * The team a declaration is about, by its id, once the caller is found a
 * member of it: 404 when there is no such team, 403 when the caller is not a
 * member of it.
 */
async function ownTeam(context: HandlerContext, teamId: string, doing: string): Promise<{ id: string; key: string }> {
  const [team] = await context.tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, context.orgId), eq(teams.id, teamId)));
  if (team === undefined) throw new Refusal("record-not-found", "There is no such team.");
  if (!(await inTeam(context, actingUserOf(context), team.id))) {
    throw new Refusal("forbidden", `Only a member of ${team.key} may ${doing} the APIs it consumes.`);
  }
  return team;
}

/** A team's declaration for an API, with who made it; undefined when the team has none. */
async function declarationOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, apiId: string, teamId: string): Promise<ConsumerDeclaration | undefined> {
  const [row] = await tx
    .select({
      declaredAt: apiConsumers.declaredAt,
      lastConfirmedAt: apiConsumers.lastConfirmedAt,
      staleAt: apiConsumers.staleAt,
      userId: users.id,
      login: users.githubLogin,
      bot: users.bot,
    })
    .from(apiConsumers)
    .innerJoin(users, and(eq(users.orgId, apiConsumers.orgId), eq(users.id, apiConsumers.declaredByUserId)))
    .where(and(eq(apiConsumers.orgId, orgId), eq(apiConsumers.apiId, apiId), eq(apiConsumers.teamId, teamId)));
  return row === undefined ? undefined : declarationView(row);
}

function declarationView(row: { declaredAt: Date; lastConfirmedAt: Date; staleAt: Date | null; userId: string; login: string; bot: boolean }): ConsumerDeclaration {
  return {
    declaredBy: { id: row.userId, login: row.login, kind: "human", bot: row.bot },
    declaredAt: row.declaredAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    stale: row.staleAt !== null,
  };
}

export const API_CONSUMER_HANDLERS: Handlers = {
  [declareConsumer.id]: defineHandler(declareConsumer, async ({ api, team }, context) => {
    const own = await ownTeam(context, team, "declare");
    const [found] = await context.tx
      .select({ name: apis.name, unregisteredAt: apis.unregisteredAt })
      .from(apis)
      .where(and(eq(apis.orgId, context.orgId), eq(apis.id, api)));
    if (found === undefined) throw new Refusal("record-not-found", "There is no such API.");
    if (found.unregisteredAt !== null) throw new Refusal("conflict", `${found.name} is not registered, so no team can declare that it consumes it.`);
    const now = context.now();
    // A declaration made again keeps its declarer and its times.
    await context.tx
      .insert(apiConsumers)
      .values({ orgId: context.orgId, apiId: api, teamId: own.id, declaredByUserId: actingUserOf(context), declaredAt: now, lastConfirmedAt: now })
      .onConflictDoNothing();
    const declaration = await declarationOf(context, api, own.id);
    if (declaration === undefined) throw new Error("A declaration was not stored.");
    return { declaration: { ...declaration, api: { id: api, name: found.name }, team: own } };
  }),

  [removeConsumer.id]: defineHandler(removeConsumer, async ({ api, team }, context) => {
    const own = await ownTeam(context, team, "remove the declarations of");
    await context.tx.delete(apiConsumers).where(and(eq(apiConsumers.orgId, context.orgId), eq(apiConsumers.apiId, api), eq(apiConsumers.teamId, own.id)));
    return { api, team: own.id, declared: false as const };
  }),

  [reconfirmConsumer.id]: defineHandler(reconfirmConsumer, async ({ api, team }, context) => {
    const own = await ownTeam(context, team, "re-confirm");
    const [found] = await context.tx
      .select({ name: apis.name })
      .from(apis)
      .where(and(eq(apis.orgId, context.orgId), eq(apis.id, api)));
    // Only the confirmation time moves, and with it the request to re-confirm and the stale mark end.
    const updated = await context.tx
      .update(apiConsumers)
      .set({ lastConfirmedAt: context.now(), reconfirmationRequestedAt: null, staleAt: null })
      .where(and(eq(apiConsumers.orgId, context.orgId), eq(apiConsumers.apiId, api), eq(apiConsumers.teamId, own.id)))
      .returning({ apiId: apiConsumers.apiId });
    if (found === undefined || updated.length === 0) throw new Refusal("record-not-found", `${own.key} has no such declaration.`);
    const declaration = await declarationOf(context, api, own.id);
    if (declaration === undefined) throw new Error("A re-confirmed declaration was not found.");
    return { declaration: { ...declaration, api: { id: api, name: found.name }, team: own } };
  }),

  [listTeamApis.id]: defineHandler(listTeamApis, async ({ team }, context) => {
    const found = await teamOfKey(context, team);
    if (found === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const provider = teams;
    const rows = await context.tx
      .select({ id: apis.id, name: apis.name, providerId: provider.id, providerKey: provider.key })
      .from(apis)
      .innerJoin(provider, and(eq(provider.orgId, apis.orgId), eq(provider.id, apis.providerTeamId)))
      .where(and(eq(apis.orgId, context.orgId), isNull(apis.unregisteredAt)))
      .orderBy(asc(apis.name));
    const listed = [];
    for (const row of rows) {
      listed.push({
        id: row.id,
        provider: { id: row.providerId, key: row.providerKey },
        declaration: (await declarationOf(context, row.id, found.id)) ?? null,
        untrusted: { name: row.name },
      });
    }
    return { team: found, member: await inTeam(context, actingUserOf(context), found.id), apis: listed };
  }),
};

/** A request to re-confirm a declaration, as the standing list of the web inbox shows it. */
export interface ReconfirmationView {
  api: { id: string; name: string };
  team: { id: string; key: string };
  lastConfirmedAt: string;
  requestedAt: string;
  stale: boolean;
  text: string;
}

/** The requests to re-confirm the declarations of the user's teams, of registered APIs, that wait, oldest first. */
export async function reconfirmationViews({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<ReconfirmationView[]> {
  const rows = await tx
    .select({
      apiId: apis.id,
      apiName: apis.name,
      teamId: teams.id,
      teamKey: teams.key,
      lastConfirmedAt: apiConsumers.lastConfirmedAt,
      requestedAt: apiConsumers.reconfirmationRequestedAt,
      staleAt: apiConsumers.staleAt,
    })
    .from(apiConsumers)
    .innerJoin(apis, and(eq(apis.orgId, apiConsumers.orgId), eq(apis.id, apiConsumers.apiId)))
    .innerJoin(teams, and(eq(teams.orgId, apiConsumers.orgId), eq(teams.id, apiConsumers.teamId)))
    .innerJoin(teamMembers, and(eq(teamMembers.orgId, apiConsumers.orgId), eq(teamMembers.teamId, apiConsumers.teamId), eq(teamMembers.userId, userId)))
    .where(and(eq(apiConsumers.orgId, orgId), isNotNull(apiConsumers.reconfirmationRequestedAt), isNull(apis.unregisteredAt)))
    .orderBy(asc(apiConsumers.reconfirmationRequestedAt), asc(teams.key), asc(apis.name));
  return rows.map((row) => ({
    api: { id: row.apiId, name: row.apiName },
    team: { id: row.teamId, key: row.teamKey },
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    requestedAt: (row.requestedAt ?? row.lastConfirmedAt).toISOString(),
    stale: row.staleAt !== null,
    text: reconfirmationText({ team: row.teamKey, api: row.apiName, lastConfirmedAt: row.lastConfirmedAt, staleAt: row.staleAt }),
  }));
}

/**
 * Asks, in the caller's transaction, for the re-confirmation of every
 * declaration of a registered API whose day has come by `now`, and marks stale
 * every one whose stale day has.
 */
async function markDueDeclarations({ tx, orgId }: OrgContext, now: Date): Promise<void> {
  const today = sql`(${now}::timestamptz AT TIME ZONE 'UTC')::date`;
  const confirmedOn = sql`(api_consumers.last_confirmed_at AT TIME ZONE 'UTC')::date`;
  const registered = sql`EXISTS (SELECT 1 FROM apis a WHERE a.org_id = api_consumers.org_id AND a.id = api_consumers.api_id AND a.unregistered_at IS NULL)`;
  await tx.execute(sql`
    UPDATE api_consumers SET reconfirmation_requested_at = ${now}
     WHERE org_id = ${orgId} AND reconfirmation_requested_at IS NULL AND ${registered}
       AND ${confirmedOn} + ${RECONFIRM_AFTER_DAYS}::int <= ${today}`);
  await tx.execute(sql`
    UPDATE api_consumers SET stale_at = ${now}
     WHERE org_id = ${orgId} AND stale_at IS NULL AND ${registered}
       AND ${confirmedOn} + ${STALE_AFTER_DAYS}::int <= ${today}`);
}

/** A re-confirmation email to send: to whom, about which request, and the values it holds. */
interface UnsentReconfirmation {
  apiId: string;
  apiName: string;
  teamId: string;
  teamKey: string;
  requestedAt: Date;
  lastConfirmedAt: Date;
  userId: string;
  email: string;
}

/**
 * Each day, asks for the re-confirmations whose day has come and marks the
 * stale declarations, and, once email is set up, emails each member of each
 * team asked who has not had that request's email yet.
 */
export const requestConsumerReconfirmations: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("apis.request_reconfirmations", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "11 0 * * *",
  async handle(_job, { database, now, mailer, installUrl }) {
    let unsent: UnsentReconfirmation[];
    try {
      unsent = await withOrg(database, async (context) => {
        await markDueDeclarations(context, now());
        if (mailer === undefined || !mailer.configured || installUrl === undefined) return [];
        const rows = await context.tx
          .select({
            apiId: apis.id,
            apiName: apis.name,
            teamId: teams.id,
            teamKey: teams.key,
            requestedAt: apiConsumers.reconfirmationRequestedAt,
            lastConfirmedAt: apiConsumers.lastConfirmedAt,
            userId: users.id,
            email: users.email,
          })
          .from(apiConsumers)
          .innerJoin(apis, and(eq(apis.orgId, apiConsumers.orgId), eq(apis.id, apiConsumers.apiId)))
          .innerJoin(teams, and(eq(teams.orgId, apiConsumers.orgId), eq(teams.id, apiConsumers.teamId)))
          .innerJoin(teamMembers, and(eq(teamMembers.orgId, apiConsumers.orgId), eq(teamMembers.teamId, apiConsumers.teamId)))
          .innerJoin(members, and(eq(members.orgId, teamMembers.orgId), eq(members.userId, teamMembers.userId)))
          .innerJoin(users, and(eq(users.orgId, teamMembers.orgId), eq(users.id, teamMembers.userId)))
          .where(
            and(
              eq(apiConsumers.orgId, context.orgId),
              isNotNull(apiConsumers.reconfirmationRequestedAt),
              isNull(apis.unregisteredAt),
              isNotNull(users.email),
              sql`NOT EXISTS (SELECT 1 FROM ${apiConsumerReconfirmationEmails} e
                               WHERE e.org_id = ${apiConsumers.orgId} AND e.api_id = ${apiConsumers.apiId} AND e.team_id = ${apiConsumers.teamId}
                                 AND e.requested_at = ${apiConsumers.reconfirmationRequestedAt} AND e.user_id = ${users.id})`,
            ),
          )
          .orderBy(asc(apiConsumers.reconfirmationRequestedAt), asc(teams.key), asc(apis.name), asc(users.githubLogin));
        return rows.map((row) => ({ ...row, requestedAt: row.requestedAt ?? now(), email: row.email ?? "" }));
      });
    } catch (error) {
      // Before setup there is no org, and so no declaration.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    if (mailer === undefined || installUrl === undefined) return;
    for (const request of unsent) {
      await mailer.send(request.email, RECONFIRMATION_REQUEST, {
        team: teamKey(request.teamKey),
        api: apiNameText(request.apiName),
        lastConfirmedOn: serverDay(request.lastConfirmedAt),
        lastDay: serverDay(new Date(`${dayAfter(request.lastConfirmedAt, STALE_AFTER_DAYS - 1)}T00:00:00Z`)),
        staleOn: serverDay(new Date(`${dayAfter(request.lastConfirmedAt, STALE_AFTER_DAYS)}T00:00:00Z`)),
        page: installLink(installUrl, `/${request.teamKey}`),
      });
      await withOrg(database, ({ tx, orgId }) =>
        tx
          .insert(apiConsumerReconfirmationEmails)
          .values({ orgId, apiId: request.apiId, teamId: request.teamId, requestedAt: request.requestedAt, userId: request.userId, sentAt: now() })
          .onConflictDoNothing(),
      );
    }
  },
};
