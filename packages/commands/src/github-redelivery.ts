import { githubApp, githubDeliveries, githubRedeliveries, type Database } from "@tiehall/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { askRedelivery, attemptFailed, madeAfter, readDeliveryLog, type DeliveryAttempt } from "./github-delivery-log.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { githubModeOf } from "./github-mode.ts";
import { defineJobType } from "./jobs.ts";
import { createLogger, type Logger } from "./log.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// Redelivering failed GitHub deliveries (tracker-mirrors: Failed GitHub
// deliveries are redelivered; design.md, Design rules: Tracker mirrors;
// design.md, Self-hosting decisions: S9; design.md, Technical decisions:
// T16). GitHub does not retry a delivery that failed, such as one it sent
// while the install was restarting. So while GitHub runs in webhook mode, a
// job every 10 minutes reads the App's delivery log from shortly before its
// previous run (from when the App's credentials were stored at first, and at
// most as far back as GitHub still redelivers) and, for each delivery whose
// last attempt failed and that Tiehall has not stored, asks GitHub to
// redeliver that attempt. The redelivery keeps the delivery id, so
// /webhooks/github stores it once and it is processed once. A redelivery that
// fails too is asked for again at the next run, up to a few times, so a
// delivery that can never succeed does not cost a call every run; one that
// Tiehall stored although GitHub logged it as failed, such as when the answer
// came too late for GitHub, is never asked for. Only deliveries made after the
// App's credentials were stored count, because the install accepts deliveries
// from then on (design.md, Readings to confirm: R6). In polling mode nothing
// is asked for.

/** How many times Tiehall asks GitHub to redeliver one delivery before it gives up on it. */
export const REDELIVERY_ASKS = 5;

/** How far back GitHub redelivers a delivery: three days. */
const REDELIVERY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** How far before the previous run each run reads, so an attempt GitHub logged late is still seen. */
const OVERLAP_MS = 15 * 60 * 1000;

export interface RedeliveryOptions {
  /** The app's database, as the app role; setup must be complete. */
  database: Database;
  app: GitHubAppAccess;
  now: () => Date;
  logger?: Logger;
}

/** One run: asks GitHub to redeliver the failed deliveries it finds, and returns how many it asked for. */
export async function redeliverFailedDeliveries(options: RedeliveryOptions): Promise<number> {
  const { database, app } = options;
  const logger = (options.logger ?? createLogger()).child({ integration: "github" });
  const started = options.now();
  const state = await withOrg(database, async (context) => {
    const [row] = await context.tx
      .select({ appId: githubApp.appId, storedAt: githubApp.storedAt, checkedAt: githubApp.redeliveryCheckedAt })
      .from(githubApp)
      .where(eq(githubApp.orgId, context.orgId));
    if (row === undefined || row.appId !== app.appId) return undefined;
    return (await githubModeOf(context)) === "webhook" ? row : undefined;
  });
  if (state === undefined) return 0;

  const since = new Date(
    Math.max(state.storedAt.getTime(), state.checkedAt === null ? 0 : state.checkedAt.getTime() - OVERLAP_MS, started.getTime() - REDELIVERY_WINDOW_MS),
  );
  const attempts = await readDeliveryLog(app.client, since, logger);
  // An App without a webhook has no delivery log, and so nothing to redeliver.
  if (attempts === undefined) return 0;

  // The last attempt of each delivery made after the credentials were stored, which counts only when it failed.
  const last = new Map<string, DeliveryAttempt>();
  for (const attempt of attempts) {
    if (!madeAfter(attempt, state.storedAt)) continue;
    const seen = last.get(attempt.deliveryId);
    if (seen === undefined || attempt.id > seen.id) last.set(attempt.deliveryId, attempt);
  }
  const failed = [...last.values()].filter(attemptFailed).sort((a, b) => a.id - b.id);

  const toAsk = await withOrg(database, async ({ tx, orgId }) => {
    if (failed.length === 0) return [];
    const ids = failed.map(({ deliveryId }) => deliveryId);
    const stored = new Set(
      (
        await tx
          .select({ deliveryId: githubDeliveries.deliveryId })
          .from(githubDeliveries)
          .where(and(eq(githubDeliveries.orgId, orgId), inArray(githubDeliveries.deliveryId, ids)))
      ).map(({ deliveryId }) => deliveryId),
    );
    const asks = new Map(
      (
        await tx
          .select({ deliveryId: githubRedeliveries.deliveryId, asks: githubRedeliveries.asks })
          .from(githubRedeliveries)
          .where(and(eq(githubRedeliveries.orgId, orgId), inArray(githubRedeliveries.deliveryId, ids)))
      ).map(({ deliveryId, asks: count }) => [deliveryId, count]),
    );
    return failed.filter(({ deliveryId }) => !stored.has(deliveryId) && (asks.get(deliveryId) ?? 0) < REDELIVERY_ASKS);
  });

  for (const attempt of toAsk) {
    await askRedelivery(app.client, attempt.id);
    await withOrg(database, ({ tx, orgId }) =>
      tx
        .insert(githubRedeliveries)
        .values({ orgId, deliveryId: attempt.deliveryId })
        .onConflictDoUpdate({
          target: [githubRedeliveries.orgId, githubRedeliveries.deliveryId],
          set: { asks: sql`${githubRedeliveries.asks} + 1`, lastAskedAt: sql`now()` },
        }),
    );
  }

  await withOrg(database, async ({ tx, orgId }) => {
    await tx
      .update(githubApp)
      .set({ redeliveryCheckedAt: started })
      .where(and(eq(githubApp.orgId, orgId), eq(githubApp.appId, app.appId)));
    // GitHub no longer redelivers these, so how often Tiehall asked no longer matters.
    await tx
      .delete(githubRedeliveries)
      .where(and(eq(githubRedeliveries.orgId, orgId), lt(githubRedeliveries.lastAskedAt, new Date(started.getTime() - REDELIVERY_WINDOW_MS))));
  });
  if (toAsk.length > 0) logger.info("github: asked GitHub to redeliver failed deliveries", { asked: toAsk.length });
  return toAsk.length;
}

/** The job that asks GitHub to redeliver failed deliveries, every 10 minutes while GitHub runs in webhook mode. */
export const redeliverGitHubDeliveries: WorkerJob<Record<string, never>> = {
  // The next run, 10 minutes later, does the work of one that failed.
  type: defineJobType<Record<string, never>>("github.redeliver_deliveries", 1, {
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
  }),
  schedule: "*/10 * * * *",
  async handle(_job, { database, github, now }) {
    if (github === undefined) throw new Error("The worker gives this job no GitHub App to ask for redeliveries as.");
    const app = await github.app();
    if (app === undefined) return;
    try {
      await redeliverFailedDeliveries({ database, app, now });
    } catch (error) {
      // Before setup completes nothing is redelivered; the first run after it reads back to when the credentials were stored.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
