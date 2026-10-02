import { createHash } from "node:crypto";
import { Refusal } from "@tiehall/core";
import { idempotencyKeys } from "@tiehall/db";
import { and, eq, lt } from "drizzle-orm";
import type { Caller } from "./caller.ts";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// Idempotency-Key on POST (public-api: POST operations take an
// Idempotency-Key; design.md, Decisions this change rests on: D28 #20),
// following draft-ietf-httpapi-idempotency-key-header. The header is optional.
// A key is kept per caller for 24 hours, with a digest of the first call's
// method, path and body and the response that call got.
//
// The key's row is written in the call's own transaction, before the handler
// runs, and gets the response once the handler has answered: so the key and
// the call's change commit together, a call that fails keeps no key, and a
// repeat that arrives while the first call is still running waits for it on
// the row's primary key instead of running beside it. Then:
// - a repeat with the same method, path and body gets the first status and
//   body, and nothing runs again;
// - a repeat with another body gets 422 and does not run;
// - a key older than 24 hours counts as unused, and an hourly job deletes it.

export const IDEMPOTENCY_KEY_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** A key and what it guards: whose it is, the digest of the call it was sent with, and the time. */
export interface IdempotencyClaim {
  caller: string;
  key: string;
  digest: Buffer;
  now: Date;
}

/** A first call's response, stored with its key. */
export interface StoredResponse {
  status: number;
  body: string;
}

/**
 * A repeat of a call that already ran: the transaction is rolled back, since
 * nothing ran, and the route answers with the first call's response.
 */
export class IdempotentReplay extends Error {
  override name = "IdempotentReplay";
  readonly response: StoredResponse;
  constructor(response: StoredResponse) {
    super("This call repeats one that already ran with the same Idempotency-Key.");
    this.response = response;
  }
}

/**
 * The key from the Idempotency-Key header: a structured string, such as
 * "8e03978e-40d5-43e8-bc93-6894a57f9324", or the same text without its
 * quotes; undefined when it is not 1 to 255 visible characters.
 */
export function parseIdempotencyKey(header: string): string | undefined {
  const quoted = /^"(.*)"$/.exec(header);
  const key = quoted === null ? header : (quoted[1] ?? "");
  return /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,255}$/.test(key) && key.trim() === key && key !== "" ? key : undefined;
}

/**
 * Whose keys a caller's keys are: one token, one client for its user, or one
 * workflow of a CI repository, as the run's token names both, so that a repeat
 * from another workflow, which an API bound to a workflow refuses, never gets
 * the answer a run of that workflow got.
 */
export function idempotencyCallerOf(caller: Caller): string {
  switch (caller.kind) {
    case "personal_access_token":
      return `pat:${caller.tokenId}`;
    case "oauth_token":
      return `oauth:${caller.userId}:${caller.clientId}`;
    case "ci":
      return `ci:${caller.repositoryId}:${caller.jobWorkflowRef}`;
    case "web_session":
      return `web:${caller.userId}`;
    case "system_job":
      return `system:${caller.job}`;
    case "integration_event":
      return `integration:${caller.source}`;
  }
}

/** The digest a call's key is bound to: its method, its path and its body, byte for byte. */
export function requestDigest(method: string, path: string, body: string): Buffer {
  return createHash("sha256").update(`${method} ${path}\n`).update(body).digest();
}

/**
 * Runs the call once for its key, inside the call's transaction: it claims the
 * key, runs the call and stores its response; a repeat throws IdempotentReplay
 * with the stored response, and a repeat with another body a 422 refusal.
 */
export async function runOnce<T>(
  context: OrgContext,
  claim: IdempotencyClaim,
  run: () => Promise<T>,
  respond: (output: T) => StoredResponse,
): Promise<T> {
  const { tx, orgId } = context;
  const cutoff = new Date(claim.now.getTime() - IDEMPOTENCY_KEY_HOURS * HOUR_MS);
  const theKey = and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.caller, claim.caller), eq(idempotencyKeys.key, claim.key));
  // A key older than 24 hours counts as unused, even before the hourly job has deleted it.
  await tx.delete(idempotencyKeys).where(and(theKey, lt(idempotencyKeys.createdAt, cutoff)));
  // Waits for a call that holds the same key uncommitted, and claims the key unless that call committed it.
  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ orgId, caller: claim.caller, key: claim.key, requestDigest: claim.digest, createdAt: claim.now })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (claimed.length === 0) {
    const [kept] = await tx
      .select({ digest: idempotencyKeys.requestDigest, status: idempotencyKeys.status, body: idempotencyKeys.body })
      .from(idempotencyKeys)
      .where(theKey);
    if (kept === undefined || kept.status === null || kept.body === null) {
      throw new Error("An idempotency key was claimed but holds no response.");
    }
    if (!kept.digest.equals(claim.digest)) {
      throw new Refusal(
        "idempotency-key-reused",
        "This Idempotency-Key was sent with a different call in the last 24 hours; use a new key for a new call.",
      );
    }
    throw new IdempotentReplay({ status: kept.status, body: kept.body });
  }
  const output = await run();
  const { status, body } = respond(output);
  await tx.update(idempotencyKeys).set({ status, body }).where(theKey);
  return output;
}

/** Deletes the keys older than 24 hours by the worker's clock, every hour. */
export const pruneIdempotencyKeys: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("idempotency.prune_keys", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "17 * * * *",
  async handle(_job, { database, now }) {
    const cutoff = new Date(now().getTime() - IDEMPOTENCY_KEY_HOURS * HOUR_MS);
    try {
      await withOrg(database, ({ tx, orgId }) =>
        tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.orgId, orgId), lt(idempotencyKeys.createdAt, cutoff))),
      );
    } catch (error) {
      // Before setup there is no org, and so no key.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
