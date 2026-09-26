import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@tiehall/core";

// The confirmation nonce (agent-safety: One confirmation approves one action;
// design.md, Technical decisions: T3; design.md, Self-hosting decisions: S7).
// A review page carries a nonce of 32 random bytes that expires 5 minutes
// after it is issued and is bound to the user, the session and a digest of the
// action. It is signed with the install's auth secret over all of these, so
// issuing it stores nothing and the page's GET changes no state; the SHA-256
// of its random bytes is what the server records once the nonce has approved
// its action, so it approves no other.

/** The random bytes a confirmation nonce carries. */
export const CONFIRMATION_NONCE_BYTES = 32;
/** How long a confirmation nonce is valid after its review page issued it. */
export const CONFIRMATION_NONCE_TTL_SECONDS = 300;

/** What a nonce is bound to: the user, the web session and the digest of one action. */
export interface NonceBinding {
  userId: string;
  sessionId: string;
  /** The action's digest, as actionDigest() gives it. */
  digest: string;
}

/** A nonce that is valid for its binding: the id the server records it as used by, and when it expires. */
export interface CheckedNonce {
  /** The SHA-256 of its random bytes, in hex. */
  id: string;
  expiresAt: Date;
}

/**
 * The digest of an action for every review page but a proposal's: it covers
 * the command, or the gated route, and its exact input, in canonical JSON, so
 * the same input in any key order has the same digest and any other input
 * another.
 */
export function actionDigest(action: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ action, input }), "utf8").digest("hex");
}

/** The key that signs nonces, apart from every other use of the install's auth secret. */
function nonceKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("tiehall confirmation nonce v1").digest();
}

function signature(secret: string, random: string, expires: number, binding: NonceBinding): Buffer {
  return createHmac("sha256", nonceKey(secret))
    .update([random, String(expires), binding.userId, binding.sessionId, binding.digest].join("\n"), "utf8")
    .digest();
}

/** A new nonce for a review page: its random bytes, when it expires in seconds since the epoch, and its signature. */
export function issueConfirmationNonce(
  secret: string,
  binding: NonceBinding,
  options: { now: Date; random?: (size: number) => Buffer },
): string {
  const random = (options.random ?? randomBytes)(CONFIRMATION_NONCE_BYTES).toString("base64url");
  const expires = Math.floor(options.now.getTime() / 1000) + CONFIRMATION_NONCE_TTL_SECONDS;
  return `${random}.${expires}.${signature(secret, random, expires, binding).toString("base64url")}`;
}

const NONCE = /^([A-Za-z0-9_-]{43})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

/**
 * The nonce, when it was issued under this secret for this binding and has
 * not expired at this time; undefined otherwise. Whether it has been used is
 * the server's record to check.
 */
export function checkConfirmationNonce(secret: string, nonce: string, binding: NonceBinding, now: Date): CheckedNonce | undefined {
  const [, random = "", expiresText = "", given = ""] = NONCE.exec(nonce) ?? [];
  if (random === "") return undefined;
  const expires = Number(expiresText);
  const expected = signature(secret, random, expires, binding);
  const signed = Buffer.from(given, "base64url");
  if (signed.byteLength !== expected.byteLength || !timingSafeEqual(signed, expected)) return undefined;
  const expiresAt = new Date(expires * 1000);
  if (now.getTime() >= expiresAt.getTime()) return undefined;
  return { id: createHash("sha256").update(Buffer.from(random, "base64url")).digest("hex"), expiresAt };
}
