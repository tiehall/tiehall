import { declareConsumer, listTeamApis, removeConsumer, type consumerDeclaration } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { apiConsumers, apis, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import { teamOfKey } from "./request-keys.ts";
import type { OrgContext } from "./with-org.ts";

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
// requests or history it has.

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
    .select({ declaredAt: apiConsumers.declaredAt, lastConfirmedAt: apiConsumers.lastConfirmedAt, userId: users.id, login: users.githubLogin, bot: users.bot })
    .from(apiConsumers)
    .innerJoin(users, and(eq(users.orgId, apiConsumers.orgId), eq(users.id, apiConsumers.declaredByUserId)))
    .where(and(eq(apiConsumers.orgId, orgId), eq(apiConsumers.apiId, apiId), eq(apiConsumers.teamId, teamId)));
  return row === undefined ? undefined : declarationView(row);
}

function declarationView(row: { declaredAt: Date; lastConfirmedAt: Date; userId: string; login: string; bot: boolean }): ConsumerDeclaration {
  return {
    declaredBy: { id: row.userId, login: row.login, kind: "human", bot: row.bot },
    declaredAt: row.declaredAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
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
