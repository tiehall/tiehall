import { pruneUsedConfirmationNonces } from "./confirmations.ts";
import { pruneIdempotencyKeys } from "./idempotency.ts";
import { expireProposals } from "./proposal-endings.ts";
import { notifyWaitingProposals } from "./proposal-waiting.ts";
import type { JobData } from "./jobs.ts";
import { pruneSecurityEventOrigins } from "./security-event-origins.ts";
import type { WorkerJob } from "./worker.ts";

/** The jobs the worker role runs. Each task that adds a kind of job adds it here. */
export const WORKER_JOBS: readonly WorkerJob<JobData>[] = [
  pruneSecurityEventOrigins,
  pruneIdempotencyKeys,
  pruneUsedConfirmationNonces,
  expireProposals,
  notifyWaitingProposals,
];
