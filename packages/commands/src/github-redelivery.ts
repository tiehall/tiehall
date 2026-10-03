import { githubApp, githubDeliveries, githubRedeliveries, type Database } from "@tiehall/db";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { askRedelivery, attemptFailed, madeAfterCredentials, readDeliveryLog, readFromCredentials, type DeliveryAttempt } from "./github-delivery-log.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { githubModeOf, recordGivenUpDelivery } from "./github-mode.ts";
import { defineJobType, type JobSender } from "./jobs.ts";
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
// fails too is asked for again at the next run, 5 times at most, so a
// delivery that can never succeed does not cost a call every run. A request
// GitHub refuses, such as with 422 for a delivery it no longer redelivers,
// counts as one of those 5, and the run goes on to the next delivery; GitHub
// failing a request, with a server error or no answer, fails the run. One that
// Tiehall stored although GitHub logged it as failed, such as when the answer
// came too late for GitHub, is never asked for. Only deliveries made after the
// App's credentials were stored count, because the install accepts deliveries
// from then on (design.md, Readings to confirm: R6). In polling mode nothing
// is asked for.
//
// A delivery given up (tracker-mirrors: Failed GitHub deliveries are
// redelivered; github-layer-hardening: design.md, Decisions this change rests
// on: D50 (15); design.md, Technical decisions: T8): a run that finds a
// delivery asked for 5 times, whose latest attempt in the log is the
// redelivery the fifth request made (GitHub's ids only grow, so it is newer
// than the attempt that request named) and still failed, or whose fifth
// request GitHub refused, and that Tiehall does not hold, gives it up, once;
// while GitHub has not logged the redelivery it owes, the run waits for the
// next: in one write it marks the
// delivery given up, so later runs record nothing more for it, and records the
// give-up on the App's row, which moves GitHub to polling mode unless an
// admin chose webhook mode (github-mode.ts). The parameters are the design's:
// 5 requests, a log read back at most 3 days, GitHub's redelivery window, and
// from 15 minutes before the previous run.

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
  /** Where the security event of a move to polling mode would send jobs; it sends none. */
  jobs?: JobSender;
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
    Math.max(
      readFromCredentials(state.storedAt).getTime(),
      state.checkedAt === null ? 0 : state.checkedAt.getTime() - OVERLAP_MS,
      started.getTime() - REDELIVERY_WINDOW_MS,
    ),
  );
  const attempts = await readDeliveryLog(app.client, since, logger);
  // An App without a webhook has no delivery log, and so nothing to redeliver.
  if (attempts === undefined) return 0;

  // The last attempt of each delivery made after the credentials were stored, which counts only when it failed.
  const last = new Map<string, DeliveryAttempt>();
  for (const attempt of attempts) {
    if (!madeAfterCredentials(attempt, state.storedAt)) continue;
    const seen = last.get(attempt.deliveryId);
    if (seen === undefined || attempt.id > seen.id) last.set(attempt.deliveryId, attempt);
  }
  const failed = [...last.values()].filter(attemptFailed).sort((a, b) => a.id - b.id);

  const { toAsk, toGiveUp } = await withOrg(database, async ({ tx, orgId }) => {
    if (failed.length === 0) return { toAsk: [], toGiveUp: [] };
    const ids = failed.map(({ deliveryId }) => deliveryId);
    const stored = new Set(
      (
        await tx
          .select({ deliveryId: githubDeliveries.deliveryId })
          .from(githubDeliveries)
          .where(and(eq(githubDeliveries.orgId, orgId), inArray(githubDeliveries.deliveryId, ids)))
      ).map(({ deliveryId }) => deliveryId),
    );
    const asked = new Map(
      (
        await tx
          .select({
            deliveryId: githubRedeliveries.deliveryId,
            asks: githubRedeliveries.asks,
            givenUpAt: githubRedeliveries.givenUpAt,
            lastAskedAttemptId: githubRedeliveries.lastAskedAttemptId,
          })
          .from(githubRedeliveries)
          .where(and(eq(githubRedeliveries.orgId, orgId), inArray(githubRedeliveries.deliveryId, ids)))
      ).map(({ deliveryId, asks, givenUpAt, lastAskedAttemptId }) => [deliveryId, { asks, givenUp: givenUpAt !== null, lastAskedAttemptId }]),
    );
    const missing = failed.filter(({ deliveryId }) => !stored.has(deliveryId));
    return {
      toAsk: missing.filter(({ deliveryId }) => (asked.get(deliveryId)?.asks ?? 0) < REDELIVERY_ASKS),
      // Asked for 5 times, and the redelivery the fifth request made failed too, or GitHub refused that request: given
      // up, once. Until GitHub logs the redelivery it owes, the log's latest attempt is the one the fifth request named,
      // and the run waits for the next.
      toGiveUp: missing.filter(({ deliveryId, id }) => {
        const seen = asked.get(deliveryId);
        return seen !== undefined && seen.asks >= REDELIVERY_ASKS && !seen.givenUp && (seen.lastAskedAttemptId === null || id > seen.lastAskedAttemptId);
      }),
    };
  });

  let refused = 0;
  for (const attempt of toAsk) {
    // The attempt whose redelivery GitHub now owes, which no request GitHub refused leaves.
    let awaited: number | null = attempt.id;
    try {
      await askRedelivery(app.client, attempt.id);
    } catch (error) {
      // GitHub refused this request itself, as with 422 for a delivery it no longer redelivers: it counts as one of
      // the delivery's requests, and the run asks for the others. GitHub failing the call stops the run.
      if (!refusedRequest(error)) throw error;
      refused += 1;
      awaited = null;
    }
    await withOrg(database, ({ tx, orgId }) =>
      tx
        .insert(githubRedeliveries)
        .values({ orgId, deliveryId: attempt.deliveryId, lastAskedAttemptId: awaited })
        .onConflictDoUpdate({
          target: [githubRedeliveries.orgId, githubRedeliveries.deliveryId],
          set: { asks: sql`${githubRedeliveries.asks} + 1`, lastAskedAt: sql`now()`, lastAskedAttemptId: awaited },
        }),
    );
  }

  if (toGiveUp.length > 0) {
    const jobs = options.jobs ?? { send: () => Promise.reject(new Error("Giving up a GitHub delivery sends no job.")) };
    const polling = await withOrg(database, async (context) => {
      const marked = await context.tx
        .update(githubRedeliveries)
        .set({ givenUpAt: sql`now()` })
        .where(
          and(
            eq(githubRedeliveries.orgId, context.orgId),
            inArray(
              githubRedeliveries.deliveryId,
              toGiveUp.map(({ deliveryId }) => deliveryId),
            ),
            isNull(githubRedeliveries.givenUpAt),
          ),
        )
        .returning({ deliveryId: githubRedeliveries.deliveryId });
      return marked.length > 0 && (await recordGivenUpDelivery(context, jobs, app.appId));
    });
    logger.warn("github: gave up failed deliveries that GitHub could not redeliver", { givenUp: toGiveUp.length });
    if (polling) logger.info("github: a given-up delivery put GitHub in polling mode");
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
  if (refused > 0) logger.warn("github: GitHub refused requests to redeliver failed deliveries", { refused });
  if (toAsk.length > 0) logger.info("github: asked GitHub to redeliver failed deliveries", { asked: toAsk.length });
  return toAsk.length;
}

/**
 * Whether GitHub answered a request to redeliver with a refusal of that
 * request: a 4xx status other than 401, 403 and 429, which refuse the App or
 * its rate rather than the request.
 */
function refusedRequest(error: unknown): boolean {
  if ((error as { response?: unknown } | undefined)?.response === undefined) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
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
  async handle(_job, { database, github, now, jobs }) {
    if (github === undefined) throw new Error("The worker gives this job no GitHub App to ask for redeliveries as.");
    const app = await github.app();
    if (app === undefined) return;
    try {
      await redeliverFailedDeliveries({ database, app, now, ...(jobs === undefined ? {} : { jobs }) });
    } catch (error) {
      // Before setup completes nothing is redelivered; the first run after it reads back to when the credentials were stored.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
