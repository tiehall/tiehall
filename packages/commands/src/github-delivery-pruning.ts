import { githubDeliveries, orgs } from "@tiehall/db";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { defineJobType } from "./jobs.ts";
import type { WorkerJob } from "./worker.ts";

// Stored GitHub deliveries are deleted (tracker-mirrors: GitHub webhooks are
// verified, deduplicated and processed in the background; self-host-install:
// The setup code guards the setup screen; github-layer-hardening: design.md,
// Decisions this change rests on: D50 (4); design.md, Technical decisions:
// T3). A daily job, beside the pruning of IP addresses and user agents
// (security-event-origins.ts), deletes by the worker's clock:
// - a delivery 7 days after it was processed, its payload with it: longer
//   than GitHub's 3-day redelivery window, so a delivery GitHub sends again
//   within it is still recognized by its id and processed once;
// - a delivery never processed, such as one held until setup completes or
//   one whose job failed and waits in the dead-letter queue, 30 days after it
//   arrived, whether or not setup has completed; a held one that is gone is
//   not processed when setup completes.
// The changes the poll of polling mode stores are rows of the same table, and
// follow the same rule. The job runs before setup completes too, because
// deliveries are stored from the moment the setup screen has stored the App's
// credentials: it reads the install's one org row directly, as
// /webhooks/github does when it stores a delivery, and not through withOrg(),
// which refuses to run before setup completes. It deletes in batches, each in
// a transaction of its own, so a large backlog holds no long lock.
// github_redeliveries keeps its own pruning (github-redelivery.ts).

/** How many days a delivery is kept after it was processed. */
export const PROCESSED_DELIVERY_RETENTION_DAYS = 7;

/** How many days a delivery that is never processed is kept after it arrived. */
export const UNPROCESSED_DELIVERY_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many deliveries one transaction deletes at most. */
const BATCH = 500;

export const pruneGitHubDeliveries: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("github.prune_deliveries", 1, {
    retryLimit: 3,
    retryDelaySeconds: 600,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "40 3 * * *",
  async handle(_job, { database, now }) {
    const time = now().getTime();
    const processedBefore = new Date(time - PROCESSED_DELIVERY_RETENTION_DAYS * DAY_MS);
    const arrivedBefore = new Date(time - UNPROCESSED_DELIVERY_RETENTION_DAYS * DAY_MS);
    for (;;) {
      const deleted = await database.transaction(async (tx) => {
        const [org] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
        // Before the setup screen makes the org, no delivery is stored.
        if (org === undefined) return 0;
        const due = await tx
          .select({ deliveryId: githubDeliveries.deliveryId })
          .from(githubDeliveries)
          .where(
            and(
              eq(githubDeliveries.orgId, org.id),
              or(
                and(isNotNull(githubDeliveries.processedAt), lt(githubDeliveries.processedAt, processedBefore)),
                and(isNull(githubDeliveries.processedAt), lt(githubDeliveries.receivedAt, arrivedBefore)),
              ),
            ),
          )
          .limit(BATCH)
          .for("update", { skipLocked: true });
        if (due.length === 0) return 0;
        await tx.delete(githubDeliveries).where(
          and(
            eq(githubDeliveries.orgId, org.id),
            inArray(
              githubDeliveries.deliveryId,
              due.map(({ deliveryId }) => deliveryId),
            ),
          ),
        );
        return due.length;
      });
      if (deleted < BATCH) return;
    }
  },
};
