import { and, eq, exists, lt, sql } from "drizzle-orm";
import { events, securityEventOrigins } from "@tiehall/db";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// IP addresses and user agents are kept apart for 90 days (activity-log: IP
// addresses and user agents are kept apart for 90 days; design.md, Technical
// decisions: T6 and Self-hosting decisions: S14). The write path keeps them
// beside security events; this daily job deletes those whose event is more
// than 90 days old by the worker's clock, and leaves the events.

export const ORIGIN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const pruneSecurityEventOrigins: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("activity_log.prune_origins", 1, {
    retryLimit: 3,
    retryDelaySeconds: 600,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "30 3 * * *",
  async handle(_job, { database, now }) {
    const cutoff = new Date(now().getTime() - ORIGIN_RETENTION_DAYS * DAY_MS);
    try {
      await withOrg(database, async ({ tx, orgId }) => {
        const old = tx
          .select({ one: sql`1` })
          .from(events)
          .where(
            and(
              eq(events.orgId, securityEventOrigins.orgId),
              eq(events.number, securityEventOrigins.eventNumber),
              lt(events.occurredAt, cutoff),
            ),
          );
        await tx.delete(securityEventOrigins).where(and(eq(securityEventOrigins.orgId, orgId), exists(old)));
      });
    } catch (error) {
      // Before setup there is no org, and so no security event.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
