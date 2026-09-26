import { usedConfirmationNonces, type Database } from "@tiehall/db";
import { and, eq, lt } from "drizzle-orm";
import type { WebSessionCaller } from "./caller.ts";
import { actionDigest, checkConfirmationNonce, CONFIRMATION_NONCE_TTL_SECONDS, issueConfirmationNonce } from "./confirmation-nonce.ts";
import type { Confirmations } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The confirmation nonce (agent-safety: One confirmation approves one action;
// design.md, Technical decisions: T3 and T8; design.md, Self-hosting
// decisions: S7). A review page issues a nonce bound to the signed-in user,
// their web session and the digest of the action with its exact input; it
// stores nothing. The nonce is checked and consumed:
// - by execute(), in the call's transaction, before a command that needs the
//   confirmation step runs;
// - by the route guard, for a route of the sign-in service that the step
//   gates, such as the consent approval, whose action is the route and its
//   input.
// Consuming it records the SHA-256 of its random bytes as used, in the same
// transaction as the action, so the nonce approves that one action and no
// other. A nonce that is expired, used, or bound to another user, session or
// action is not valid, and neither is one whose action then fails: that
// transaction rolls back, and the nonce was not used.

export interface ConfirmationNonces extends Confirmations {
  /** A nonce for a review page, bound to this user, this session and this action with this exact input. */
  issue(caller: WebSessionCaller, action: string, input: unknown): string;
}

export interface ConfirmationNoncesOptions {
  /** The install's auth secret (TIEHALL_AUTH_SECRET), which signs the nonces; read when it is first needed. */
  secret: string | (() => string);
  /** The clock nonces are issued and checked by; the system clock unless a test controls it. */
  now?: () => Date;
}

export function createConfirmationNonces(options: ConfirmationNoncesOptions): ConfirmationNonces {
  const now = options.now ?? (() => new Date());
  const secret = () => (typeof options.secret === "string" ? options.secret : options.secret());
  return {
    issue(caller, action, input) {
      return issueConfirmationNonce(
        secret(),
        { userId: caller.userId, sessionId: caller.sessionId, digest: actionDigest(action, input) },
        { now: now() },
      );
    },
    async consume({ tx, orgId }, claim) {
      const binding = { userId: claim.userId, sessionId: claim.sessionId, digest: actionDigest(claim.commandId, claim.input) };
      const checked = checkConfirmationNonce(secret(), claim.nonce, binding, now());
      if (checked === undefined) return false;
      // A nonce already recorded as used, by this call's action or another, approves nothing more.
      const recorded = await tx
        .insert(usedConfirmationNonces)
        .values({ orgId, nonceHash: Buffer.from(checked.id, "hex"), expiresAt: checked.expiresAt })
        .onConflictDoNothing()
        .returning({ orgId: usedConfirmationNonces.orgId });
      return recorded.length === 1;
    },
  };
}

/** What a gated route of the sign-in service confirms: the route as its action, and the input it acts on. */
export interface GatedRouteClaim {
  caller: WebSessionCaller;
  /** The route's action, such as oauth.approve_client, which its review page issued the nonce for. */
  action: string;
  input: unknown;
  nonce: string;
}

/**
 * The route guard's check for a gated route: it consumes the nonce, in its own
 * transaction, and says whether the route may run; a route that may not
 * answers 403 and changes nothing.
 */
export function consumeForGatedRoute(database: Database, confirmations: Confirmations, claim: GatedRouteClaim): Promise<boolean> {
  const { caller, action, input, nonce } = claim;
  return withOrg(database, (context) =>
    confirmations.consume(context, { nonce, userId: caller.userId, sessionId: caller.sessionId, commandId: action, input }),
  );
}

/**
 * Deletes the records of used nonces every hour, once their nonces expired
 * more than a nonce's lifetime ago by the worker's clock, which leaves room
 * for a web process whose clock runs behind the worker's.
 */
export const pruneUsedConfirmationNonces: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("confirmation.prune_used_nonces", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "47 * * * *",
  async handle(_job, { database, now }) {
    const cutoff = new Date(now().getTime() - CONFIRMATION_NONCE_TTL_SECONDS * 1000);
    try {
      await withOrg(database, ({ tx, orgId }) =>
        tx.delete(usedConfirmationNonces).where(and(eq(usedConfirmationNonces.orgId, orgId), lt(usedConfirmationNonces.expiresAt, cutoff))),
      );
    } catch (error) {
      // Before setup nothing can be confirmed, and so no nonce is used.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
