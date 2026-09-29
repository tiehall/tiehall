import { defineJobType } from "./jobs.ts";
import { readInstallations } from "./github-installations.ts";
import { createLogger } from "./log.ts";
import { checkDepartures } from "./organization-departures.ts";
import { SetupRequiredError } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The GitHub reconciliation, every 15 minutes, whether GitHub runs in webhook
// mode or polling mode (tracker-mirrors: Covered repositories follow each
// connected installation; sign-in: Leaving the GitHub organization ends
// access; github-app-reachability: design.md, Design rules: Finding
// installations). Deliveries can be lost, and an App without a webhook gets
// none, so each run:
// - lists the App's installations with the App's own token, and reads the
//   repositories of each connected one that is neither suspended nor deleted,
//   so an installation, a change of its repositories, a suspension or a
//   deletion whose delivery was lost counts within 15 minutes;
// - then checks every member Tiehall saw in an organization against the
//   whole member list of each working connected organization, and removes
//   those GitHub positively reports gone (organization-departures.ts), as the
//   system.
// Before setup completes there is nothing to reconcile.

export const reconcileGitHub: WorkerJob<Record<string, never>> = {
  // Five attempts over about an hour, then the dead-letter queue, as for every integration job (design.md, Decisions this change rests on: D28 #83).
  type: defineJobType<Record<string, never>>("github.reconcile", 1, {
    retryLimit: 4,
    retryDelaySeconds: 240,
    retryBackoff: true,
    expireInSeconds: 600,
  }),
  schedule: "*/15 * * * *",
  async handle(_job, { database, github }) {
    if (github === undefined) throw new Error("The worker gives this job no GitHub App to reconcile.");
    const app = await github.app();
    if (app === undefined) return;
    const logger = createLogger().child({ job: "github.reconcile" });
    try {
      await readInstallations({ database, app, logger });
      await checkDepartures({ database, app, logger, provenance: { actorKind: "system" } }, { every: true });
    } catch (error) {
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
