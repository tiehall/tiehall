import { getGitHubIntegration, setGitHubMode, storeGitHubWebhookSecret } from "@tiehall/catalog";
import { GITHUB_MODES, githubModeChanged, githubWebhookSecretStored, Refusal } from "@tiehall/core";
import { githubApp, githubInstallations, integrationSecrets, type Database } from "@tiehall/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { emailAdminAlerts } from "./admin-alerts.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { attemptFailed, madeAfterCredentials, readDeliveryLog, readFromCredentials } from "./github-delivery-log.ts";
import { storeSecret } from "./integration-secrets.ts";
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
// Storing an App's credentials sets the mode (github-app.ts;
// github-app-reachability: design.md, Design rules: An App without a
// webhook): an App without a webhook secret runs in polling mode from the
// start, and one with a secret starts in webhook mode, which its delivery log
// settles once: after the App's first installation, a job that runs
// every minute reads the log, counting only deliveries made after the App's
// credentials were stored, because the install accepts deliveries from then
// on; the delivery for the installation made during setup is the first that
// counts. A failed delivery puts GitHub in polling mode; deliveries that all
// succeeded keep it in webhook mode. Until a delivery made after the
// credentials were stored is logged, the job looks again at its next run. It
// never reads the log of an App without a webhook secret, which has none, and
// GitHub's 404 for a missing log is no failed delivery. The
// admin page shows the mode, and an admin switches it there, with the checks
// every web UI write passes and no confirmation step; an admin's switch
// settles the mode too, so the check never undoes it. Each change of the mode
// is a security event for a changed integration, naming the admin or the
// system, and why.
//
// A delivery given up (tracker-mirrors: Failed GitHub deliveries are
// redelivered; tracker-mirrors: Broken integrations are surfaced;
// github-layer-hardening: design.md, Decisions this change rests on: D50
// (15); design.md, Technical decisions: T8): when the redelivery job gives up
// a delivery (github-redelivery.ts), the App's row records the give-up, which
// the banner about GitHub's webhook reads, and GitHub moves to polling mode,
// as the check after the first installation would move it, in the same
// write, with a security event that names no user. It does not undo an
// admin's switch to webhook mode: the row records who last set the mode, an
// admin or Tiehall, and when an admin's switch to webhook mode was the latest
// change, the mode stays. The give-up is cleared by an admin's next switch of
// the mode, by a delivery that /webhooks/github verifies and stores after it
// (github-webhooks.ts), and by storing the App's credentials, which also sets
// the mode as Tiehall's again (github-app.ts).
//
// A webhook removed on GitHub (tracker-mirrors: GitHub and Jira each run in
// webhook mode or polling mode; tracker-mirrors: Broken integrations are
// surfaced; decisions-from-groups-15-28: design.md, Decisions this change
// rests on: D55 (6); Technical decisions: T2): while GitHub runs in webhook
// mode and a webhook secret is stored, GitHub's 404 for the App's delivery
// log, which the redelivery job and the check after the first installation
// read, means that GitHub holds no webhook for the App any more, as when
// someone removed it in the App's settings. No delivery can arrive then, so
// GitHub moves to polling mode whoever last set the mode, an admin's switch
// to webhook mode included, in one write with a security event that names no
// user and the cause webhook_removed; the same write raises the banner about
// GitHub's webhook, as a give-up does, emailing the admins when it was not
// showing, and records that the banner's cause is the removed webhook. The
// banner clears as a give-up's does; an admin who switches back to webhook
// mode before the webhook is restored sees the next run move GitHub to
// polling mode again. While no webhook secret is stored, as for an App
// created without a webhook, a 404 is no failure and changes nothing.
//
// Moving to webhook mode (github-app-reachability: design.md, Design rules:
// Moving to webhook mode): an App without a webhook moves to webhook mode once
// an admin has added the webhook on GitHub and stored the same secret in
// Tiehall. Storing it is an admin action with the confirmation step; the
// secret is no part of the action's input, which the review page's URL
// carries, but a value the admin types into a password field of the review
// page's form, so it travels only in the body of the POST that applies the
// action. It is stored encrypted, replaces any stored secret, is never shown
// again, and is a security event for a changed integration. A switch to
// webhook mode is refused with 409 while no webhook secret is stored, because
// in webhook mode Tiehall stops polling and would refuse every delivery.

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
    if (mode === "webhook" && !(await hasWebhookSecret(context))) {
      throw new Refusal("conflict", "No webhook secret is stored, so every delivery would be refused: store the App's webhook secret first.");
    }
    return context.write(async (writer) => {
      // An admin's switch settles the mode, so the check of the delivery log never undoes it, nor does a delivery
      // given up later undo a switch to webhook mode; it clears a give-up, and with it the banner.
      await writer.tx
        .update(githubApp)
        .set({ mode, modeSetBy: "admin", webhookGivenUpAt: null, webhookRemoved: false, modeSettledAt: sql`coalesce(${githubApp.modeSettledAt}, now())` })
        .where(eq(githubApp.orgId, writer.orgId));
      await writer.record(githubModeChanged, { mode, previousMode, cause: "admin_switch" });
      return { mode, previousMode };
    });
  }),
};

/** The review page of storing the App's webhook secret, which names the action and never the secret. */
export const GITHUB_MODE_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [storeGitHubWebhookSecret.id]: async (_input, context) => {
    const title = "Store the GitHub App's webhook secret";
    const [row] = await context.tx.select({ name: githubApp.name, mode: githubApp.mode }).from(githubApp).where(eq(githubApp.orgId, context.orgId));
    if (row === undefined) return { title, lines: [{ text: "The install has no GitHub App yet, so there is no webhook secret to store." }] };
    const replacing = await hasWebhookSecret(context);
    return {
      title,
      lines: [
        {
          text: replacing
            ? `Store a new webhook secret for the install's GitHub App, ${row.name}, in place of the one stored now.`
            : `Store the webhook secret of the install's GitHub App, ${row.name}.`,
        },
        {
          text:
            "Enter the secret you set under Webhook in the App's settings on GitHub. Tiehall verifies every delivery from GitHub with it: " +
            "a delivery signed with any other secret is refused. Tiehall stores it encrypted and never shows it again.",
        },
        {
          text:
            row.mode === "polling"
              ? "GitHub keeps running in polling mode until you switch it to webhook mode on the GitHub page."
              : "GitHub runs in webhook mode, so deliveries are verified with the new secret as soon as you confirm.",
        },
      ],
    };
  },
};

/** Storing the App's webhook secret, which the admin entered on the review page. */
export const GITHUB_WEBHOOK_SECRET_HANDLERS: Handlers = {
  [storeGitHubWebhookSecret.id]: defineHandler(storeGitHubWebhookSecret, async (_input, context) => {
    const [row] = await context.tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, context.orgId)).for("update");
    if (row === undefined) throw new Refusal("conflict", "The install has no GitHub App yet, so there is no webhook secret to store.");
    const secrets = context.secrets;
    if (secrets === undefined) throw new Error("This process has no TIEHALL_SECRET_KEY to encrypt the webhook secret with.");
    const secret = context.sealed["secret"];
    if (secret === undefined) throw new Error("execute() gave no webhook secret to store.");
    const replaced = await hasWebhookSecret(context);
    return context.write(async (writer) => {
      await storeSecret(writer, secrets(), "github_app.webhook_secret", secret);
      await writer.record(githubWebhookSecretStored, { replaced });
      return { stored: true as const, replaced };
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
 * settle yet or the mode is settled already. It runs only for an App that has
 * a webhook secret, in webhook mode: an App without a webhook has no delivery
 * log, and Tiehall does not ask for one (github-app-reachability: design.md,
 * Design rules: An App without a webhook).
 */
export async function checkDeliveryLog(options: DeliveryLogCheckOptions): Promise<GitHubMode | undefined> {
  const { database, app } = options;
  const due = await withOrg(database, async (context) => {
    const [row] = await context.tx
      .select({ appId: githubApp.appId, mode: githubApp.mode })
      .from(githubApp)
      .where(and(eq(githubApp.orgId, context.orgId), isNull(githubApp.modeSettledAt)));
    if (row === undefined || row.appId !== app.appId || row.mode !== "webhook" || !(await hasWebhookSecret(context))) return false;
    // After the first installation: a listing found one of this App.
    const [installed] = await context.tx
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, context.orgId), eq(githubInstallations.appId, app.appId)))
      .limit(1);
    return installed !== undefined;
  });
  return due ? settleModeFromDeliveryLog(options) : undefined;
}

/**
 * Reads the App's delivery log from when its credentials were stored and
 * settles the mode by what it finds, as the check does; returns the mode it
 * settled, or undefined when it settled nothing. GitHub's 404 for an App
 * without a delivery log is no failed delivery: it changes nothing, and
 * reports no broken integration to admins.
 */
export async function settleModeFromDeliveryLog(options: DeliveryLogCheckOptions): Promise<GitHubMode | undefined> {
  const { database, app } = options;
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const stored = await withOrg(database, async ({ tx, orgId }) => {
    const [row] = await tx.select({ appId: githubApp.appId, storedAt: githubApp.storedAt }).from(githubApp).where(eq(githubApp.orgId, orgId));
    return row?.appId === app.appId ? row.storedAt : undefined;
  });
  if (stored === undefined) return undefined;
  const attempts = await readDeliveryLog(app.client, readFromCredentials(stored), logger);
  const jobs = options.jobs ?? { send: () => Promise.reject(new Error("Settling GitHub's mode sends no job.")) };
  if (attempts === undefined) {
    // No delivery log at all: with a webhook secret stored, in webhook mode, GitHub holds no webhook for the App any
    // more; otherwise, as for an App without a webhook, there is nothing to settle, and nothing failed.
    const removed = await withOrg(database, (context) => recordRemovedWebhook(context, jobs, app.appId));
    if (!removed) return undefined;
    logger.info("github: GitHub holds no webhook for the App any more, which put GitHub in polling mode");
    return "polling";
  }
  const counted = attempts.filter((attempt) => madeAfterCredentials(attempt, stored));
  if (counted.length === 0) return undefined;
  const settled: GitHubMode = counted.some(attemptFailed) ? "polling" : "webhook";

  const changed = await withOrg(database, async (context) => {
    // Settled once, for the App the log was read for; an admin's switch meanwhile wins.
    const updated = await context.tx
      .update(githubApp)
      .set({ mode: settled, modeSetBy: "tiehall", modeSettledAt: sql`now()` })
      .where(and(eq(githubApp.orgId, context.orgId), eq(githubApp.appId, app.appId), isNull(githubApp.modeSettledAt), eq(githubApp.mode, "webhook")))
      .returning({ appId: githubApp.appId });
    if (updated.length === 0) return undefined;
    if (settled === "polling") {
      await writeIn(context, jobs, { actorKind: "system" }, (writer) =>
        writer.record(githubModeChanged, { mode: "polling", previousMode: "webhook", cause: "failed_delivery" }),
      );
    }
    return settled;
  });
  if (changed === "polling") logger.info("github: a failed delivery put GitHub in polling mode");
  return changed;
}

/**
 * Records, in the caller's transaction, that the redelivery job gave up a
 * delivery of the App with this id: the App's row records the give-up, when
 * it has none yet, and GitHub moves to polling mode with a security event
 * that names no user, unless an admin's switch to webhook mode was the latest
 * change of the mode. Returns whether it moved the mode; it records nothing
 * when the App's credentials were replaced meanwhile.
 */
export async function recordGivenUpDelivery(context: OrgContext, jobs: JobSender, appId: number): Promise<boolean> {
  const [row] = await context.tx
    .select({ appId: githubApp.appId, mode: githubApp.mode, modeSetBy: githubApp.modeSetBy, givenUpAt: githubApp.webhookGivenUpAt })
    .from(githubApp)
    .where(eq(githubApp.orgId, context.orgId))
    .for("update");
  if (row === undefined || row.appId !== appId) return false;
  if (row.givenUpAt === null) {
    const [raised] = await context.tx
      .update(githubApp)
      .set({ webhookGivenUpAt: sql`now()`, webhookRemoved: false })
      .where(eq(githubApp.orgId, context.orgId))
      .returning({ at: githubApp.webhookGivenUpAt });
    // The banner shows from now on, and every admin is emailed about it once, when SMTP is set (admin-alerts.ts).
    await jobs.send(context.tx, emailAdminAlerts.type.queue, { alert: "github_webhook", raisedAt: (raised?.at ?? new Date()).toISOString() });
  }
  // An admin who chose webhook mode may be fixing the webhook at this moment: their choice stands.
  if (row.mode !== "webhook" || row.modeSetBy === "admin") return false;
  await context.tx
    .update(githubApp)
    .set({ mode: "polling", modeSetBy: "tiehall", modeSettledAt: sql`coalesce(${githubApp.modeSettledAt}, now())` })
    .where(eq(githubApp.orgId, context.orgId));
  await writeIn(context, jobs, { actorKind: "system" }, (writer) =>
    writer.record(githubModeChanged, { mode: "polling", previousMode: "webhook", cause: "given_up_delivery" }),
  );
  return true;
}

/**
 * Records, in the caller's transaction, that GitHub answered a read of the
 * delivery log of the App with this id with 404 (decisions-from-groups-15-28:
 * design.md, Technical decisions: T2). While GitHub runs in webhook mode and a
 * webhook secret is stored, that means GitHub holds no webhook for the App any
 * more: GitHub moves to polling mode, whoever last set the mode, with a
 * security event that names no user, and the banner about GitHub's webhook
 * shows with the removed webhook as its cause; raising it when it was not
 * showing emails every admin once. Returns whether it moved the mode; it
 * records nothing in polling mode, while no webhook secret is stored, or when
 * the App's credentials were replaced meanwhile.
 */
export async function recordRemovedWebhook(context: OrgContext, jobs: JobSender, appId: number): Promise<boolean> {
  const [row] = await context.tx
    .select({ appId: githubApp.appId, mode: githubApp.mode, givenUpAt: githubApp.webhookGivenUpAt })
    .from(githubApp)
    .where(eq(githubApp.orgId, context.orgId))
    .for("update");
  if (row === undefined || row.appId !== appId || row.mode !== "webhook" || !(await hasWebhookSecret(context))) return false;
  const [raised] = await context.tx
    .update(githubApp)
    .set({
      mode: "polling",
      modeSetBy: "tiehall",
      modeSettledAt: sql`coalesce(${githubApp.modeSettledAt}, now())`,
      webhookGivenUpAt: sql`coalesce(${githubApp.webhookGivenUpAt}, now())`,
      webhookRemoved: true,
    })
    .where(eq(githubApp.orgId, context.orgId))
    .returning({ at: githubApp.webhookGivenUpAt });
  // The banner shows from now on, and every admin is emailed about it once, when SMTP is set (admin-alerts.ts).
  if (row.givenUpAt === null) {
    await jobs.send(context.tx, emailAdminAlerts.type.queue, { alert: "github_webhook", raisedAt: (raised?.at ?? new Date()).toISOString() });
  }
  await writeIn(context, jobs, { actorKind: "system" }, (writer) =>
    writer.record(githubModeChanged, { mode: "polling", previousMode: "webhook", cause: "webhook_removed" }),
  );
  return true;
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
