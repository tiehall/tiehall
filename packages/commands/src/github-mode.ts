import { getGitHubIntegration, setGitHubMode } from "@tiehall/catalog";
import { GITHUB_MODES, githubModeChanged, Refusal } from "@tiehall/core";
import { githubApp, githubInstallations, integrationSecrets, type Database } from "@tiehall/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { attemptFailed, madeAfter, readDeliveryLog } from "./github-delivery-log.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { defineJobType, type JobSender } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";
import { writeIn } from "./write.ts";

// GitHub's mode (tracker-mirrors: GitHub and Jira each run in webhook mode or
// polling mode; activity-log: Which actions are security events; design.md,
// Self-hosting decisions: S9; design.md, Readings to confirm: R6). In webhook
// mode, changes reach Tiehall as deliveries to /webhooks/github, and failed
// deliveries are redelivered (github-redelivery.ts); in polling mode, Tiehall
// polls GitHub every 60 seconds. The 15-minute reconciliation runs in both.
//
// An App created with a webhook starts in webhook mode, and its delivery log
// settles the mode once: after the App's first installation, a job that runs
// every minute reads the log, counting only deliveries made after the App's
// credentials were stored, because the install accepts deliveries from then
// on; the delivery for the installation made during setup is the first that
// counts. A failed delivery puts GitHub in polling mode; deliveries that all
// succeeded keep it in webhook mode. Until a delivery made after the
// credentials were stored is logged, the job looks again at its next run. The
// admin page shows the mode, and an admin switches it there, with the checks
// every web UI write passes and no confirmation step; an admin's switch
// settles the mode too, so the check never undoes it. Each change of the mode
// is a security event for a changed integration, naming the admin or the
// system, and why.

export { GITHUB_MODES };
export type GitHubMode = (typeof GITHUB_MODES)[number];

/** GitHub's mode, read in the caller's transaction; undefined while no App is stored. */
export async function githubModeOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<GitHubMode | undefined> {
  const [row] = await tx.select({ mode: githubApp.mode }).from(githubApp).where(eq(githubApp.orgId, orgId));
  return row === undefined ? undefined : row.mode === "polling" ? "polling" : "webhook";
}

/** Whether a webhook secret is stored for the install's App, to verify its deliveries with. */
async function hasWebhookSecret({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<boolean> {
  const [secret] = await tx
    .select({ name: integrationSecrets.name })
    .from(integrationSecrets)
    .where(and(eq(integrationSecrets.orgId, orgId), eq(integrationSecrets.name, "github_app.webhook_secret")));
  return secret !== undefined;
}

export const GITHUB_MODE_HANDLERS: Handlers = {
  [getGitHubIntegration.id]: defineHandler(getGitHubIntegration, async (_input, context) => {
    const [row] = await context.tx.select().from(githubApp).where(eq(githubApp.orgId, context.orgId));
    if (row === undefined) return { app: null };
    return {
      app: {
        name: row.name,
        slug: row.slug,
        owner: row.ownerLogin,
        ownerType: row.ownerType === "Organization" ? ("Organization" as const) : ("User" as const),
        mode: row.mode === "polling" ? ("polling" as const) : ("webhook" as const),
        webhookSecret: await hasWebhookSecret(context),
      },
    };
  }),

  [setGitHubMode.id]: defineHandler(setGitHubMode, async ({ mode }, context) => {
    const [row] = await context.tx
      .select({ mode: githubApp.mode })
      .from(githubApp)
      .where(eq(githubApp.orgId, context.orgId))
      .for("update");
    if (row === undefined) throw new Refusal("conflict", "The install has no GitHub App yet, so it has no mode to switch.");
    const previousMode: GitHubMode = row.mode === "polling" ? "polling" : "webhook";
    // A switch to the mode GitHub runs in already changes nothing.
    if (previousMode === mode) return { mode, previousMode };
    return context.write(async (writer) => {
      // An admin's switch settles the mode, so the check of the delivery log never undoes it.
      await writer.tx
        .update(githubApp)
        .set({ mode, modeSettledAt: sql`coalesce(${githubApp.modeSettledAt}, now())` })
        .where(eq(githubApp.orgId, writer.orgId));
      await writer.record(githubModeChanged, { mode, previousMode, cause: "admin_switch" });
      return { mode, previousMode };
    });
  }),
};

export interface DeliveryLogCheckOptions {
  /** The app's database, as the app role; setup must be complete. */
  database: Database;
  app: GitHubAppAccess;
  /** Where the security event's write would send jobs; it sends none. */
  jobs?: JobSender;
  logger?: Logger;
}

/**
 * The check of the App's delivery log after its first installation: settles
 * the mode once a delivery made after the credentials were stored is logged,
 * and returns the mode it settled, or undefined while there is nothing to
 * settle yet or the mode is settled already.
 */
export async function checkDeliveryLog(options: DeliveryLogCheckOptions): Promise<GitHubMode | undefined> {
  const { database, app } = options;
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const pending = await withOrg(database, async ({ tx, orgId }) => {
    const [row] = await tx
      .select({ appId: githubApp.appId, storedAt: githubApp.storedAt, mode: githubApp.mode })
      .from(githubApp)
      .where(and(eq(githubApp.orgId, orgId), isNull(githubApp.modeSettledAt)));
    if (row === undefined || row.appId !== app.appId || row.mode !== "webhook") return undefined;
    // After the first installation: a listing found one of this App.
    const [installed] = await tx
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.appId, app.appId)))
      .limit(1);
    return installed === undefined ? undefined : row;
  });
  if (pending === undefined) return undefined;

  const attempts = await readDeliveryLog(app.client, pending.storedAt, logger);
  const counted = (attempts ?? []).filter((attempt) => madeAfter(attempt, pending.storedAt));
  if (counted.length === 0) return undefined;
  const settled: GitHubMode = counted.some(attemptFailed) ? "polling" : "webhook";

  const jobs = options.jobs ?? { send: () => Promise.reject(new Error("Settling GitHub's mode sends no job.")) };
  const changed = await withOrg(database, async (context) => {
    // Settled once, for the App the log was read for; an admin's switch meanwhile wins.
    const updated = await context.tx
      .update(githubApp)
      .set({ mode: settled, modeSettledAt: sql`now()` })
      .where(and(eq(githubApp.orgId, context.orgId), eq(githubApp.appId, app.appId), isNull(githubApp.modeSettledAt), eq(githubApp.mode, "webhook")))
      .returning({ appId: githubApp.appId });
    if (updated.length === 0 || settled === "webhook") return false;
    await writeIn(context, jobs, { actorKind: "system" }, (writer) =>
      writer.record(githubModeChanged, { mode: "polling", previousMode: "webhook", cause: "failed_delivery" }),
    );
    return true;
  });
  if (changed) logger.info("github: a failed delivery put GitHub in polling mode");
  return settled;
}

/** The job that checks the App's delivery log after its first installation, every minute until the mode is settled. */
export const checkGitHubDeliveryLog: WorkerJob<Record<string, never>> = {
  // The next run, a minute later, does the work of one that failed.
  type: defineJobType<Record<string, never>>("github.check_delivery_log", 1, {
    retryLimit: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    expireInSeconds: 120,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, github, jobs }) {
    if (github === undefined) throw new Error("The worker gives this job no GitHub App to read the delivery log of.");
    const app = await github.app();
    if (app === undefined) return;
    try {
      await checkDeliveryLog({ database, app, ...(jobs === undefined ? {} : { jobs }) });
    } catch (error) {
      // Before setup completes there is no installation to check after; setup's own listing finds the first one.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
