import { setupCompleted } from "@tiehall/core";
import { members, orgs, setupCodes, setupSessions, type Database } from "@tiehall/db";
import { eq, sql } from "drizzle-orm";
import {
  connectInstallations,
  knownInstallations,
  listAppInstallations,
  readRepositoriesOf,
  recordCoveredRepositories,
  recordInstallations,
} from "./github-installations.ts";
import { releaseHeldDeliveries } from "./github-webhooks.ts";
import type { InstallGitHub } from "./install-github.ts";
import type { JobSender } from "./jobs.ts";
import { LOGGABLE, type Logger } from "./log.ts";
import { writeIn, type Origin } from "./write.ts";

// Completing setup (self-host-install: Setup names the company and makes the
// first admin; teams-and-roles: One org per install; activity-log: Which
// actions are security events; tracker-mirrors: Admins connect GitHub
// installations with the confirmation step; github-app-reachability:
// design.md, Design rules: Finding installations). The sign-in from the setup
// session completes setup, before its web session is stored:
// - Tiehall lists the App's installations through GitHub's API with the
//   App's own token, whether or not the App has a webhook, and reads the
//   repositories of each that is not suspended with its own token. It waits
//   for no delivery: the App is new and private, so only its owner can have
//   installed it, during setup, and every installation the list holds is the
//   operator's. An empty list completes setup with nothing connected.
// - Then, in one transaction that holds the org's row: the installations are
//   recorded and connected, with the repositories they cover; the person who
//   signed in becomes a member with the role admin, the install's first; the
//   org records the time setup completed, so the setup code and every setup
//   session stop working and /setup answers 404; the completion is recorded as
//   a security event that names the first admin; and the deliveries held
//   during setup are released to be processed.
// Setup that is already complete, a company that is not named yet, and an App
// that is not stored refuse the completion, and so the sign-in; GitHub that
// cannot be reached refuses it too, and the operator signs in again.

/** Why setup could not be completed. Its message says so, naming no secret. */
export class SetupCompletionError extends Error {
  override name = "SetupCompletionError";
  readonly [LOGGABLE] = true;
  readonly code: "setup_complete" | "company_not_named" | "no_app" | "github_failed";
  constructor(code: SetupCompletionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CompleteSetupOptions {
  /** The app's database, as the app role. */
  database: Database;
  /** The install's GitHub App, which lists its installations. */
  github: InstallGitHub;
  /** Where the jobs of the deliveries held during setup go; without it, the job that runs every minute releases them. */
  jobs?: JobSender;
  logger: Logger;
}

/** Completes setup with this user, who signed in from the setup session, as the first admin. */
export async function completeSetup(options: CompleteSetupOptions, input: { userId: string; origin: Origin }): Promise<void> {
  const app = await options.github.app();
  if (app === undefined) throw new SetupCompletionError("no_app", "Setup cannot complete before the install's GitHub App is created.");
  let listed;
  let repositories;
  try {
    listed = await listAppInstallations(app.client, options.logger);
    const live = listed.filter(({ suspendedAt }) => suspendedAt === null);
    repositories = await readRepositoriesOf(app.client, live.map(({ installationId }) => ({ id: String(installationId), installationId })));
  } catch (error) {
    options.logger.warn("setup: GitHub could not list the App's installations", { error });
    throw new SetupCompletionError("github_failed", "GitHub could not be reached to list the App's installations.");
  }

  await options.database.transaction(async (tx) => {
    // Held until the transaction ends: a delivery, and another completion, wait for it.
    const [org] = await tx.select({ id: orgs.id, name: orgs.name, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1).for("update");
    if (org === undefined || org.setupCompletedAt !== null) throw new SetupCompletionError("setup_complete", "Setup is complete already.");
    if (org.name === null) throw new SetupCompletionError("company_not_named", "Setup cannot complete before the company is named.");
    const context = { tx, orgId: org.id };

    await recordInstallations(context, app.appId, listed);
    const known = (await knownInstallations(context)).filter((installation) => installation.appId === app.appId && !installation.deleted);
    await connectInstallations(
      context,
      known.map(({ id }) => id),
    );
    for (const installation of known) {
      const read = repositories.get(String(installation.installationId));
      if (read !== undefined) await recordCoveredRepositories(context, installation.id, read);
    }

    await tx.insert(members).values({ orgId: org.id, userId: input.userId, role: "admin" });
    await tx.update(orgs).set({ setupCompletedAt: sql`now()` }).where(eq(orgs.id, org.id));
    await tx.delete(setupSessions).where(eq(setupSessions.orgId, org.id));
    await tx.delete(setupCodes).where(eq(setupCodes.orgId, org.id));
    const jobs = options.jobs;
    await writeIn(
      context,
      jobs ?? { send: () => Promise.reject(new Error("Completing setup sends no job without a job queue.")) },
      { actorKind: "web_session", userId: input.userId, surface: "web" },
      (writer) => writer.record(setupCompleted, { userId: input.userId }),
      { origin: input.origin },
    );
    if (jobs !== undefined) await releaseHeldDeliveries(context, jobs);
  });
  options.logger.info("setup: setup is complete", { userId: input.userId });
}
