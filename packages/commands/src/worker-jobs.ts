import { pruneUsedConfirmationNonces } from "./confirmations.ts";
import { processGitHubDelivery, releaseHeldGitHubDeliveries } from "./github-webhooks.ts";
import { pruneIdempotencyKeys } from "./idempotency.ts";
import { expireProposals } from "./proposal-endings.ts";
import { notifyWaitingProposals } from "./proposal-waiting.ts";
import { emailReceipts } from "./receipts.ts";
import type { JobData } from "./jobs.ts";
import { pruneSecurityEventOrigins } from "./security-event-origins.ts";
import { reconcileTrustState } from "./trust-state-reconciliation.ts";
import type { WorkerJob } from "./worker.ts";

/** The jobs the worker role runs. Each task that adds a kind of job adds it here. */
export const WORKER_JOBS: readonly WorkerJob<JobData>[] = [
  pruneSecurityEventOrigins,
  reconcileTrustState,
  pruneIdempotencyKeys,
  pruneUsedConfirmationNonces,
  expireProposals,
  notifyWaitingProposals,
  emailReceipts,
  processGitHubDelivery,
  releaseHeldGitHubDeliveries,
];
