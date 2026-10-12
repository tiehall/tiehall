import { listApis, registerApi, setWarnSwitch, unregisterApi, type registeredApi } from "@tiehall/catalog";
import { apiRegistered, apiUnregistered, Refusal } from "@tiehall/core";
import { apiConsumers, apis, githubCoveredRepositories, githubInstallations, teams, users } from "@tiehall/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { CiCaller } from "./caller.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { inTeam } from "./api-consumers.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// Registering APIs for contract reports (contract-changes: Admins register
// APIs, each bound to one repository; activity-log: Which actions are
// security events; design.md, Decisions this change rests on: D28 #4, #44;
// design.md, Readings to confirm with the founder: R19). An admin registers an
// API in the web UI, with the confirmation step, for one provider team and
// bound to one GitHub repository that a connected installation of the
// install's GitHub App covers, so that Tiehall learns when the provider's pull
// requests merge or close and who wrote them. Tiehall keeps the repository by
// GitHub's numeric ids, the repository's and its owner's, which a rename
// keeps: the GitHub Actions OIDC token of a CI run names both
// (repository_id and repository_owner_id), and only a run in that repository
// may report for the API. The owner is the account the covering installation
// is on, since an installation covers only that account's repositories. The
// admin may also bind the API to one workflow, by its job_workflow_ref, whose
// owner and repository are kept in lower case, as GitHub compares them; its
// path and ref are kept as given.
//
// A repository that no connected installation that is neither suspended nor
// deleted covers gets 409, as the error model gives a state conflict, and so
// does a name another registered API has; a team that does not exist gets
// 404. The registration and its security event commit together.
//
// The WARN switch (contract-changes: Potentially breaking changes go to a
// daily digest; design.md, Decisions this change rests on: D28 #72): an
// admin, or a member of the API's provider team, turns it on or off; anyone
// else gets 403, and an unregistered API, which has no switch until it is
// registered again, 409. It changes no request, so it records no event, and is
// no security event. Registering an API again keeps its switch as it was.
//
// Unregistering (contract-changes: Admins unregister APIs; design.md,
// Readings to confirm with the founder: R19): an admin unregisters an API
// with no confirmation step, which marks it unregistered and appends its
// security event; an API that is unregistered already changes nothing and
// records nothing. Registering an unregistered API's name again binds that
// API anew, with its provider team, repository and workflow, and the requests
// its reports opened keep naming it. Only when its repository, by GitHub's id,
// and its provider team are the ones it had does it keep the declarations that
// teams consume it, and its WARN switch; otherwise it is a new API
// (decisions-from-groups-15-28, D55 (56)): the earlier declarations are
// removed with the registration, so the consuming teams declare it again, and
// its WARN switch starts off, as a new API's does. Teams declared that they
// consume an API one team serves from one repository; a registration that
// moves the name must not route another codebase's changes to them.
//
// Which API a CI run may report for (contract-changes: Admins register APIs,
// each bound to one repository; agent-access: CI authenticates with GitHub
// Actions OIDC bound to registered repositories): a registered API, by the
// name the report gives, whose repository's GitHub id and owner's GitHub id
// are the ones the run's OIDC token names, and, for an API bound to a
// workflow, whose workflow is the run's. Any other report, one for an API
// that is unregistered or does not exist included, is refused with 403, as
// the error model gives a CI caller acting outside what it may call, so a
// CI caller learns nothing of the APIs of other repositories.

type RegisteredApi = z.input<typeof registeredApi>;

/** A repository that a connected installation, neither suspended nor deleted, covers: GitHub's ids of it and its owner, and its full name. */
interface CoveredRepository {
  repositoryId: number;
  ownerId: number;
  fullName: string;
}

/** The covered repository with this owner/name, whatever its case, as GitHub compares names; undefined when no connected installation covers it. */
async function coveredRepositoryNamed({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, fullName: string): Promise<CoveredRepository | undefined> {
  const [row] = await tx
    .select({ repositoryId: githubCoveredRepositories.repositoryId, ownerId: githubInstallations.accountId, fullName: githubCoveredRepositories.fullName })
    .from(githubCoveredRepositories)
    .innerJoin(
      githubInstallations,
      and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)),
    )
    .where(
      and(
        eq(githubCoveredRepositories.orgId, orgId),
        sql`lower(${githubCoveredRepositories.fullName}) = lower(${fullName})`,
        isNull(githubInstallations.suspendedAt),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(asc(githubCoveredRepositories.repositoryId))
    .limit(1);
  return row;
}

/** A team by its id: its key, or undefined when there is no such team. */
async function teamKeyOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, teamId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
  return row?.key;
}

/** The API with this name, registered or unregistered, with its last binding; undefined when no API has it. */
async function apiNamed(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  name: string,
  options: { lock?: boolean } = {},
): Promise<{ id: string; registered: boolean; providerTeamId: string; teamKey: string; repositoryId: number; repository: string } | undefined> {
  const query = tx
    .select({
      id: apis.id,
      unregisteredAt: apis.unregisteredAt,
      providerTeamId: apis.providerTeamId,
      teamKey: teams.key,
      repositoryId: apis.repositoryId,
      repository: apis.repositoryFullName,
    })
    .from(apis)
    .innerJoin(teams, and(eq(teams.orgId, apis.orgId), eq(teams.id, apis.providerTeamId)))
    .where(and(eq(apis.orgId, orgId), eq(apis.name, name)));
  const [row] = options.lock === true ? await query.for("update", { of: apis }) : await query;
  if (row === undefined) return undefined;
  const { unregisteredAt, ...binding } = row;
  return { ...binding, registered: unregisteredAt === null };
}

/**
 * Whether registering an unregistered API anew, for this team and this
 * repository, keeps it the same API, with the declarations that teams consume
 * it: only when both are the ones it had.
 */
function keepsTheApi(previous: { providerTeamId: string; repositoryId: number }, team: string, repository: CoveredRepository): boolean {
  return previous.providerTeamId === team && previous.repositoryId === repository.repositoryId;
}

/**
 * A job_workflow_ref as Tiehall keeps and compares it: the owner and
 * repository of the workflow in lower case, as GitHub compares their names,
 * and the path and ref as they are.
 */
export function normalJobWorkflowRef(ref: string): string {
  const [owner = "", repository = "", ...rest] = ref.split("/");
  return [owner.toLowerCase(), repository.toLowerCase(), ...rest].join("/");
}

/** The registered APIs, with their provider teams and the admins who registered them, by name; or the one with this id, registered or not. */
async function registeredApis({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, id?: string): Promise<RegisteredApi[]> {
  const rows = await tx
    .select({
      id: apis.id,
      name: apis.name,
      teamId: teams.id,
      teamKey: teams.key,
      repository: apis.repositoryFullName,
      jobWorkflowRef: apis.jobWorkflowRef,
      registeredAt: apis.registeredAt,
      warnOpensRequests: apis.warnOpensRequests,
      userId: users.id,
      login: users.githubLogin,
      bot: users.bot,
    })
    .from(apis)
    .innerJoin(teams, and(eq(teams.orgId, apis.orgId), eq(teams.id, apis.providerTeamId)))
    .innerJoin(users, and(eq(users.orgId, apis.orgId), eq(users.id, apis.registeredByUserId)))
    .where(and(eq(apis.orgId, orgId), id === undefined ? isNull(apis.unregisteredAt) : eq(apis.id, id)))
    .orderBy(asc(apis.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: { id: row.teamId, key: row.teamKey },
    repository: row.repository,
    jobWorkflowRef: row.jobWorkflowRef,
    registeredAt: row.registeredAt.toISOString(),
    registeredBy: { id: row.userId, login: row.login, kind: "human" as const, bot: row.bot },
    warnOpensRequests: row.warnOpensRequests,
  }));
}

/** The refusal of a repository that no connected installation covers. */
function notCovered(repository: string): Refusal {
  return new Refusal(
    "conflict",
    `No connected installation of the install's GitHub App covers ${repository}, so no API can be bound to it: connect an installation that covers it first.`,
  );
}

export const API_HANDLERS: Handlers = {
  // The WARN switch: an admin's, or a provider team member's; 403 for anyone else, 409 for an unregistered API.
  [setWarnSwitch.id]: defineHandler(setWarnSwitch, async ({ api, on }, context) => {
    const userId = actingUserOf(context);
    const [row] = await context.tx
      .select({ providerTeamId: apis.providerTeamId, unregisteredAt: apis.unregisteredAt })
      .from(apis)
      .where(and(eq(apis.orgId, context.orgId), eq(apis.id, api)))
      .for("update");
    if (row === undefined) throw new Refusal("record-not-found", "There is no such API.");
    if (context.member?.role !== "admin" && !(await inTeam(context, userId, row.providerTeamId))) {
      throw new Refusal("forbidden", "Only an admin or a member of the API's provider team may turn its WARN switch on or off.");
    }
    if (row.unregisteredAt !== null) throw new Refusal("conflict", "The API is unregistered, so it has no WARN switch until an admin registers it again.");
    await context.tx
      .update(apis)
      .set({ warnOpensRequests: on })
      .where(and(eq(apis.orgId, context.orgId), eq(apis.id, api)));
    return { api, warnOpensRequests: on };
  }),

  [registerApi.id]: defineHandler(registerApi, async ({ name, team, repository, jobWorkflowRef }, context) => {
    if ((await teamKeyOf(context, team)) === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const covered = await coveredRepositoryNamed(context, repository);
    if (covered === undefined) throw notCovered(repository);
    const taken = () => new Refusal("conflict", `An API named ${name} is registered already.`);
    if ((await apiNamed(context, name))?.registered === true) throw taken();
    const id = await context.write(async (writer) => {
      if (context.caller.kind !== "web_session") throw new Error("Only a web session registers an API.");
      // The unregistered API of this name, held until the registration commits, which decides whether it stays the same API.
      const previous = await apiNamed(writer, name, { lock: true });
      if (previous?.registered === true) throw taken();
      const anew = previous !== undefined && !keepsTheApi(previous, team, covered);
      const binding = {
        providerTeamId: team,
        repositoryId: covered.repositoryId,
        repositoryOwnerId: covered.ownerId,
        repositoryFullName: covered.fullName,
        jobWorkflowRef: jobWorkflowRef === undefined ? null : normalJobWorkflowRef(jobWorkflowRef),
        registeredAt: new Date(),
        registeredByUserId: context.caller.userId,
        unregisteredAt: null,
        unregisteredByUserId: null,
        // A new API's WARN switch starts off.
        ...(anew ? { warnOpensRequests: false } : {}),
      };
      // A new name is a new API; an unregistered API's name binds that API anew. A registered one keeps its binding.
      const [row] = await writer.tx
        .insert(apis)
        .values({ orgId: writer.orgId, name, ...binding })
        .onConflictDoUpdate({ target: [apis.orgId, apis.name], set: binding, setWhere: isNotNull(apis.unregisteredAt) })
        .returning({ id: apis.id });
      // Another registration took the name since it was read.
      if (row === undefined) throw taken();
      // Bound to another team or repository, it is a new API, to which the earlier declarations do not carry over.
      if (anew) await writer.tx.delete(apiConsumers).where(and(eq(apiConsumers.orgId, writer.orgId), eq(apiConsumers.apiId, row.id)));
      await writer.record(apiRegistered, { apiId: row.id, providerTeamId: team });
      return row.id;
    });
    const [api] = await registeredApis(context, id);
    if (api === undefined) throw new Error("A registered API was not found.");
    return { api };
  }),

  [listApis.id]: defineHandler(listApis, async (_input, context) => ({ apis: await registeredApis(context) })),

  [unregisterApi.id]: defineHandler(unregisterApi, async ({ api }, context) => {
    const [row] = await context.tx
      .select({ unregisteredAt: apis.unregisteredAt })
      .from(apis)
      .where(and(eq(apis.orgId, context.orgId), eq(apis.id, api)))
      .for("update");
    if (row === undefined) throw new Refusal("record-not-found", "There is no such API.");
    if (row.unregisteredAt !== null) return { api, unregistered: true as const };
    return context.write(async (writer) => {
      if (context.caller.kind !== "web_session") throw new Error("Only a web session unregisters an API.");
      await writer.tx
        .update(apis)
        .set({ unregisteredAt: new Date(), unregisteredByUserId: context.caller.userId })
        .where(and(eq(apis.orgId, writer.orgId), eq(apis.id, api)));
      await writer.record(apiUnregistered, { apiId: api });
      return { api, unregistered: true as const };
    });
  }),
};

/**
 * Whether any registered API is bound to the repository, and the repository's
 * owner, that a CI run's OIDC token names, by GitHub's ids as the token gives
 * them, compared as text so that no id is rounded or out of range.
 */
export async function repositoryHasRegisteredApi(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  { repositoryId, repositoryOwnerId }: Pick<CiCaller, "repositoryId" | "repositoryOwnerId">,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: apis.id })
    .from(apis)
    .where(
      and(
        eq(apis.orgId, orgId),
        isNull(apis.unregisteredAt),
        sql`${apis.repositoryId}::text = ${repositoryId}`,
        sql`${apis.repositoryOwnerId}::text = ${repositoryOwnerId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A registered API a CI run may report for: its id, its name and its provider team. */
export interface ReportableApi {
  id: string;
  name: string;
  providerTeamId: string;
}

/**
 * The registered API with this name that the CI run may report for: bound to
 * the repository, and the repository's owner, that the run's OIDC token
 * names, and, for an API bound to a workflow, to the run's workflow; refused
 * with 403 otherwise.
 */
export async function reportableApi({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, caller: CiCaller, name: string): Promise<ReportableApi> {
  const [row] = await tx
    .select({
      id: apis.id,
      name: apis.name,
      providerTeamId: apis.providerTeamId,
      repositoryId: apis.repositoryId,
      repositoryOwnerId: apis.repositoryOwnerId,
      jobWorkflowRef: apis.jobWorkflowRef,
    })
    .from(apis)
    .where(and(eq(apis.orgId, orgId), eq(apis.name, name), isNull(apis.unregisteredAt)));
  const allowed =
    row !== undefined &&
    String(row.repositoryId) === caller.repositoryId &&
    String(row.repositoryOwnerId) === caller.repositoryOwnerId &&
    (row.jobWorkflowRef === null || row.jobWorkflowRef === normalJobWorkflowRef(caller.jobWorkflowRef));
  if (!allowed) {
    throw new Refusal(
      "ci-caller-refused",
      "This CI run may not report for that API: it is not registered to the run's repository, or it is bound to another workflow.",
    );
  }
  return { id: row.id, name: row.name, providerTeamId: row.providerTeamId };
}

export const API_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [registerApi.id]: async (input, context) => {
    const { name, team, repository, jobWorkflowRef } = input as z.output<typeof registerApi.input>;
    const key = await teamKeyOf(context, team);
    if (key === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const covered = await coveredRepositoryNamed(context, repository);
    const title = "Register an API";
    if (covered === undefined) {
      return {
        title,
        lines: [
          { text: `No connected installation of the install's GitHub App covers ${repository}, so confirming registers nothing.` },
          { text: "Connect an installation that covers it on the GitHub page of the admin UI first." },
        ],
      };
    }
    const named = await apiNamed(context, name);
    if (named?.registered === true) {
      return { title, lines: [{ text: `An API named ${name} is registered already, so confirming registers nothing.` }] };
    }
    return {
      title,
      lines: [
        { text: `Register the API ${name} for the team ${key}, bound to the GitHub repository ${covered.fullName}.` },
        ...(named === undefined
          ? []
          : [
              {
                text:
                  `${name} was registered before, for ${named.teamKey} and ${named.repository}, and then unregistered: ` +
                  (keepsTheApi(named, team, covered)
                    ? "registering it again for the same team and repository keeps the teams' declarations that they consume it, and its WARN switch."
                    : "registering it for another team or repository makes it a new API, so the teams' declarations that they consumed it do not carry over, they declare it again, and its WARN switch starts off."),
              },
            ]),
        {
          text:
            jobWorkflowRef === undefined
              ? `CI runs of any workflow in ${covered.fullName} may then report contract changes to ${name}, each with the GitHub Actions OIDC token of its run; runs in any other repository may not.`
              : `Only runs of the workflow ${normalJobWorkflowRef(jobWorkflowRef)} in ${covered.fullName} may then report contract changes to ${name}, each with the GitHub Actions OIDC token of its run.`,
        },
        { text: `Breaking changes those reports carry open requests to the teams that declare they consume ${name}, with ${key} as the provider team.` },
      ],
    };
  },
};
