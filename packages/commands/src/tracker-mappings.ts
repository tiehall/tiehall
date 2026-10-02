import { listTrackerMappings, mapIntakeRepository, removeTrackerMapping, setMirrorOnOpen, type trackerMapping } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { githubApp, githubConnectedInstallations, githubCoveredRepositories, githubInstallations, teams, trackerMappings } from "@tiehall/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type Handlers } from "./execute.ts";
import { installationCoveringNamed } from "./github-pull-requests.ts";
import type { OrgContext } from "./with-org.ts";

// The teams' tracker mappings (tracker-mirrors: Each team maps to one
// tracker; tracker-mirrors: Mirror issues are created on claim by default;
// design.md, Decisions this change rests on: D28 #4, #81; design.md, Design
// rules: Tracker mirrors). execute() runs these operations only for an admin,
// in the web UI: they are admin actions on integrations, which no agent
// surface offers. A team maps one tracker and one place in it, or none:
// - Mapping a team to an intake repository refuses, with 409 and the error
//   model's conflict, a repository that no connected installation of the
//   install's GitHub App covers now, one neither suspended nor deleted, and a
//   team that maps a tracker already, which keeps its mapping; an admin
//   removes the mapping first. The mapping names the repository by GitHub's
//   id, which a rename keeps, so the team's mirror issues follow it. A team
//   the install does not have gets 404.
// - A new mapping mirrors on claim; turning mirroring on open on makes a
//   request's mirror issue be created when it is opened (mirrors.ts).
// - Removing a mapping stops new mirror issues for the team; the issues made
//   before stay in the tracker, and Tiehall writes to them no more while no
//   mapping names their place.
// Like every team change, a mapping changes no request and is no security
// event (design.md, Readings to confirm with the founder: R21), so it writes
// in the call's transaction without an event. Two admins mapping one team at
// once meet the mapping's key, one per team: the second gets 409.

type TrackerMappingView = z.input<typeof trackerMapping>;

/** The team, read in the call's transaction; 404 when the install has no such team. */
async function assertTeam({ tx, orgId }: OrgContext, teamId: string): Promise<void> {
  const [row] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
  if (row === undefined) throw new Refusal("record-not-found", "There is no such team.");
}

/** The team's mapping, as the operations return it; 404 when the team maps no tracker. */
async function mappingOf({ tx, orgId }: OrgContext, teamId: string): Promise<TrackerMappingView> {
  const [row] = await tx.select().from(trackerMappings).where(and(eq(trackerMappings.orgId, orgId), eq(trackerMappings.teamId, teamId)));
  if (row === undefined) throw new Refusal("record-not-found", "The team maps no tracker.");
  return { teamId: row.teamId, tracker: row.tracker as "github" | "jira", place: row.targetName, mirrorOnOpen: row.mirrorOnOpen };
}

/** The repositories that connected installations of the App cover now, neither suspended nor deleted, as owner/name, each once, in order. */
async function coveredRepositories({ tx, orgId }: OrgContext): Promise<string[]> {
  const [app] = await tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, orgId));
  if (app === undefined) return [];
  const rows = await tx
    .selectDistinct({ fullName: githubCoveredRepositories.fullName })
    .from(githubCoveredRepositories)
    .innerJoin(githubInstallations, and(eq(githubInstallations.orgId, githubCoveredRepositories.orgId), eq(githubInstallations.id, githubCoveredRepositories.installationId)))
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubCoveredRepositories.orgId), eq(githubConnectedInstallations.installationId, githubCoveredRepositories.installationId)),
    )
    .where(and(eq(githubCoveredRepositories.orgId, orgId), eq(githubInstallations.appId, app.appId), isNull(githubInstallations.suspendedAt), isNull(githubInstallations.deletedAt)))
    .orderBy(asc(githubCoveredRepositories.fullName));
  return rows.map(({ fullName }) => fullName);
}

export const TRACKER_MAPPING_HANDLERS: Handlers = {
  [listTrackerMappings.id]: defineHandler(listTrackerMappings, async (_input, context) => {
    const rows = await context.tx
      .select({ mapping: trackerMappings, key: teams.key })
      .from(trackerMappings)
      .innerJoin(teams, and(eq(teams.orgId, trackerMappings.orgId), eq(teams.id, trackerMappings.teamId)))
      .where(eq(trackerMappings.orgId, context.orgId))
      .orderBy(asc(teams.key));
    return {
      mappings: rows.map(({ mapping }) => ({
        teamId: mapping.teamId,
        tracker: mapping.tracker as "github" | "jira",
        place: mapping.targetName,
        mirrorOnOpen: mapping.mirrorOnOpen,
      })),
      repositories: await coveredRepositories(context),
    };
  }),

  [mapIntakeRepository.id]: defineHandler(mapIntakeRepository, async ({ teamId, repository, mirrorOnOpen }, context) => {
    await assertTeam(context, teamId);
    const { tx, orgId } = context;
    const [app] = await tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, orgId));
    const covering = app === undefined ? undefined : await installationCoveringNamed(context, app.appId, repository);
    if (covering === undefined) {
      throw new Refusal(
        "conflict",
        `No connected installation of the install's GitHub App covers ${repository} now, so it cannot be an intake repository. Connect an installation that covers it, or choose a repository one covers.`,
      );
    }
    const [created] = await tx
      .insert(trackerMappings)
      .values({ orgId, teamId, tracker: "github", target: String(covering.repositoryId), targetName: covering.fullName, mirrorOnOpen })
      .onConflictDoNothing()
      .returning({ teamId: trackerMappings.teamId });
    if (created === undefined) {
      throw new Refusal("conflict", "The team maps a tracker already, and a team mirrors into one tracker only. Remove its mapping first.");
    }
    return mappingOf(context, teamId);
  }),

  [setMirrorOnOpen.id]: defineHandler(setMirrorOnOpen, async ({ teamId, on }, context) => {
    await assertTeam(context, teamId);
    await mappingOf(context, teamId);
    await context.tx
      .update(trackerMappings)
      .set({ mirrorOnOpen: on })
      .where(and(eq(trackerMappings.orgId, context.orgId), eq(trackerMappings.teamId, teamId)));
    return mappingOf(context, teamId);
  }),

  [removeTrackerMapping.id]: defineHandler(removeTrackerMapping, async ({ teamId }, context) => {
    await assertTeam(context, teamId);
    const removed = await context.tx
      .delete(trackerMappings)
      .where(and(eq(trackerMappings.orgId, context.orgId), eq(trackerMappings.teamId, teamId)))
      .returning({ teamId: trackerMappings.teamId });
    if (removed.length === 0) throw new Refusal("record-not-found", "The team maps no tracker.");
    return { teamId };
  }),
};
