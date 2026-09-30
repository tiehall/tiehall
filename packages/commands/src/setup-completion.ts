import { githubInstallationConnected, setupCompleted } from "@tiehall/core";
import { githubApp, members, orgs, setupCodes, setupSessions, type Database } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import {
  connectInstallations,
  knownInstallations,
  listAppInstallations,
  readRepositoriesOf,
  recordCoveredRepositories,
  recordInstallations,
  type ListedInstallation,
  type ListedRepository,
} from "./github-installations.ts";
import { pollGitHub } from "./github-polling.ts";
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
//   a security event that names the first admin, and each connection as the
//   security event an admin's connection gets; the deliveries held during
//   setup are released to be processed; and, when GitHub runs in polling
//   mode, as for an App without a webhook, the first poll is sent at once
//   (github-app-reachability: design.md, Design rules: An App without a
//   webhook).
// Setup that is already complete, a company that is not named yet, and an App
// that is not stored refuse the completion, and so the sign-in; GitHub that
// cannot be reached refuses it too, and the operator signs in again.
//
// Closing a step that `setup reopen` opened (self-host-install: Operator
// commands on the host; sign-in: Who may sign in; github-app-reachability:
// design.md, Design rules: Finding installations). The sign-in from the setup
// session closes it, before its web session is stored, only for a person who
// is already an admin of the install, and it makes nobody an admin:
// - when the setup screen stored a new App since the step opened, Tiehall
//   lists the new App's installations and reads their repositories, outside
//   any transaction, and connects every installation the listing holds, with
//   the security event of each connection naming the admin, because that App
//   is new and only its owner can have installed it;
// - with the App in use, it connects none, so an installation an admin left
//   unconnected or disconnected stays so;
// - then, in one transaction that holds the org's row, the step closes: every
//   setup session and the setup code stop working and /setup answers 404
//   again; and, in polling mode, the first poll is sent at once.
// A person who is not an admin, and a step that is no longer open, refuse the
// close, and so the sign-in.

/** Why setup could not be completed, or a reopened step closed. Its message says so, naming no secret. */
export class SetupCompletionError extends Error {
  override name = "SetupCompletionError";
  readonly [LOGGABLE] = true;
  readonly code: "setup_complete" | "company_not_named" | "no_app" | "github_failed" | "setup_admins_only";
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
    const connected = await connectInstallations(
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
      async (writer) => {
        await writer.record(setupCompleted, { userId: input.userId });
        // Each installation made during setup is connected, as an admin's connection is recorded.
        for (const installationId of connected) await writer.record(githubInstallationConnected, { installationId });
      },
      { origin: input.origin },
    );
    if (jobs !== undefined) {
      await releaseHeldDeliveries(context, jobs);
      // The poller's first run comes as setup completes, not a minute later.
      const [stored] = await tx.select({ mode: githubApp.mode }).from(githubApp).where(eq(githubApp.orgId, org.id));
      if (stored?.mode === "polling") await jobs.send(tx, pollGitHub.type.queue, {});
    }
  });
  options.logger.info("setup: setup is complete", { userId: input.userId });
}

/**
 * Completes setup with this user as the first admin while setup is not
 * complete, or closes the step that `setup reopen` opened when that user is
 * already an admin: what the sign-in from the setup screen does before its
 * web session is stored.
 */
export async function completeOrCloseSetup(options: CompleteSetupOptions, input: { userId: string; origin: Origin }): Promise<void> {
  const [org] = await options.database.select({ completedAt: orgs.setupCompletedAt, reopenedAt: orgs.setupReopenedAt }).from(orgs).limit(1);
  if (org !== undefined && org.completedAt !== null && org.reopenedAt !== null) return closeReopenedStep(options, input);
  return completeSetup(options, input);
}

/** Whether this user is a member of the install with the role admin now. */
export async function isAdminNow(database: Database, userId: string): Promise<boolean> {
  const [row] = await database.select({ role: members.role }).from(members).where(eq(members.userId, userId)).limit(1);
  return row?.role === "admin";
}

/** Closes the step that `setup reopen` opened, as this admin's sign-in from the setup session. */
export async function closeReopenedStep(options: CompleteSetupOptions, input: { userId: string; origin: Origin }): Promise<void> {
  const app = await options.github.app();
  if (app === undefined) throw new SetupCompletionError("no_app", "The step cannot close before the install has a GitHub App.");
  const [before] = await options.database
    .select({ reopenedAt: orgs.setupReopenedAt, storedAt: githubApp.storedAt })
    .from(orgs)
    .innerJoin(githubApp, eq(githubApp.orgId, orgs.id))
    .limit(1);
  // A new App: one the setup screen stored since the step opened, whose installations are all the operator's.
  const newApp = before?.reopenedAt !== null && before?.reopenedAt !== undefined && before.storedAt.getTime() > before.reopenedAt.getTime();
  let listed: ListedInstallation[] = [];
  let repositories = new Map<string, ListedRepository[]>();
  if (newApp) {
    try {
      listed = await listAppInstallations(app.client, options.logger);
      const live = listed.filter(({ suspendedAt }) => suspendedAt === null);
      repositories = await readRepositoriesOf(app.client, live.map(({ installationId }) => ({ id: String(installationId), installationId })));
    } catch (error) {
      options.logger.warn("setup: GitHub could not list the new App's installations", { error });
      throw new SetupCompletionError("github_failed", "GitHub could not be reached to list the App's installations.");
    }
  }

  await options.database.transaction(async (tx) => {
    // Held until the transaction ends: a return from the manifest flow, and another close, wait for it.
    const [org] = await tx.select({ id: orgs.id, completedAt: orgs.setupCompletedAt, reopenedAt: orgs.setupReopenedAt }).from(orgs).limit(1).for("update");
    if (org === undefined || org.completedAt === null || org.reopenedAt === null) throw new SetupCompletionError("setup_complete", "The step setup reopen opened is closed already.");
    const [admin] = await tx
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.orgId, org.id), eq(members.userId, input.userId)))
      .for("key share");
    if (admin?.role !== "admin") {
      throw new SetupCompletionError("setup_admins_only", "Only an admin of the install can close the step that setup reopen opened.");
    }
    const [stored] = await tx.select({ appId: githubApp.appId, storedAt: githubApp.storedAt, mode: githubApp.mode }).from(githubApp).where(eq(githubApp.orgId, org.id));
    const context = { tx, orgId: org.id };
    let connected: string[] = [];
    // The App the listing read must still be the one stored, and new: another return may have replaced it meanwhile.
    if (newApp && stored !== undefined && stored.appId === app.appId && stored.storedAt.getTime() > org.reopenedAt.getTime()) {
      await recordInstallations(context, app.appId, listed);
      const known = (await knownInstallations(context)).filter((installation) => installation.appId === app.appId && !installation.deleted);
      connected = await connectInstallations(
        context,
        known.map(({ id }) => id),
      );
      for (const installation of known) {
        const read = repositories.get(String(installation.installationId));
        if (read !== undefined) await recordCoveredRepositories(context, installation.id, read);
      }
    }
    await tx.update(orgs).set({ setupReopenedAt: null }).where(eq(orgs.id, org.id));
    await tx.delete(setupSessions).where(eq(setupSessions.orgId, org.id));
    await tx.delete(setupCodes).where(eq(setupCodes.orgId, org.id));
    if (connected.length > 0) {
      await writeIn(
        context,
        options.jobs ?? { send: () => Promise.reject(new Error("Closing the step sends no job without a job queue.")) },
        { actorKind: "web_session", userId: input.userId, surface: "web" },
        async (writer) => {
          // Each installation of the new App is connected, as an admin's connection is recorded.
          for (const installationId of connected) await writer.record(githubInstallationConnected, { installationId });
        },
        { origin: input.origin },
      );
    }
    // The poller's first run for the App comes as the step closes, not a minute later.
    if (options.jobs !== undefined && stored?.mode === "polling") await options.jobs.send(tx, pollGitHub.type.queue, {});
  });
  options.logger.info("setup: the step setup reopen opened is closed", { userId: input.userId });
}
