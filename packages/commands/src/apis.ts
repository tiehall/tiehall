import { listApis, registerApi, type registeredApi } from "@tiehall/catalog";
import { apiRegistered, Refusal } from "@tiehall/core";
import { apis, githubCoveredRepositories, githubInstallations, teams, users } from "@tiehall/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
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
// does a name another API has; a team that does not exist gets 404. The
// registration and its security event commit together.

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

/** Whether an API has this name. */
async function nameTaken({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, name: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: apis.id })
    .from(apis)
    .where(and(eq(apis.orgId, orgId), eq(apis.name, name)));
  return row !== undefined;
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

/** The registered APIs, with their provider teams and the admins who registered them, by name; or the one with this id. */
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
      userId: users.id,
      login: users.githubLogin,
      bot: users.bot,
    })
    .from(apis)
    .innerJoin(teams, and(eq(teams.orgId, apis.orgId), eq(teams.id, apis.providerTeamId)))
    .innerJoin(users, and(eq(users.orgId, apis.orgId), eq(users.id, apis.registeredByUserId)))
    .where(and(eq(apis.orgId, orgId), ...(id === undefined ? [] : [eq(apis.id, id)])))
    .orderBy(asc(apis.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: { id: row.teamId, key: row.teamKey },
    repository: row.repository,
    jobWorkflowRef: row.jobWorkflowRef,
    registeredAt: row.registeredAt.toISOString(),
    registeredBy: { id: row.userId, login: row.login, kind: "human" as const, bot: row.bot },
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
  [registerApi.id]: defineHandler(registerApi, async ({ name, team, repository, jobWorkflowRef }, context) => {
    if ((await teamKeyOf(context, team)) === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const covered = await coveredRepositoryNamed(context, repository);
    if (covered === undefined) throw notCovered(repository);
    const taken = () => new Refusal("conflict", `An API named ${name} is registered already.`);
    if (await nameTaken(context, name)) throw taken();
    const id = await context.write(async (writer) => {
      if (context.caller.kind !== "web_session") throw new Error("Only a web session registers an API.");
      const [row] = await writer.tx
        .insert(apis)
        .values({
          orgId: writer.orgId,
          name,
          providerTeamId: team,
          repositoryId: covered.repositoryId,
          repositoryOwnerId: covered.ownerId,
          repositoryFullName: covered.fullName,
          jobWorkflowRef: jobWorkflowRef === undefined ? null : normalJobWorkflowRef(jobWorkflowRef),
          registeredByUserId: context.caller.userId,
        })
        .onConflictDoNothing()
        .returning({ id: apis.id });
      // Another registration took the name since it was read.
      if (row === undefined) throw taken();
      await writer.record(apiRegistered, { apiId: row.id, providerTeamId: team });
      return row.id;
    });
    const [api] = await registeredApis(context, id);
    if (api === undefined) throw new Error("A registered API was not found.");
    return { api };
  }),

  [listApis.id]: defineHandler(listApis, async (_input, context) => ({ apis: await registeredApis(context) })),
};

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
    if (await nameTaken(context, name)) {
      return { title, lines: [{ text: `An API named ${name} is registered already, so confirming registers nothing.` }] };
    }
    return {
      title,
      lines: [
        { text: `Register the API ${name} for the team ${key}, bound to the GitHub repository ${covered.fullName}.` },
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
