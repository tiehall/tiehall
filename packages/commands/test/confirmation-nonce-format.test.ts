import { describe, expect, it } from "vitest";
import {
  actionDigest,
  checkConfirmationNonce,
  CONFIRMATION_NONCE_TTL_SECONDS,
  issueConfirmationNonce,
  type NonceBinding,
} from "../src/confirmation-nonce.ts";

// The confirmation nonce (agent-safety: One confirmation approves one action;
// design.md, Technical decisions: T3; design.md, Self-hosting decisions: S7).
// Each review page carries a nonce of 32 random bytes that expires 5 minutes
// after it is issued and is bound to the user, the session and a digest of the
// action, which for every page but a proposal's covers the command and its
// exact input. The nonce is signed with the install's auth secret, so the page
// stores nothing when it is issued; the server records a nonce as used when it
// approves its action.

const SECRET = "a-secret-of-at-least-thirty-two-characters-for-tests";
const ISSUED = new Date("2026-09-26T10:00:00Z");
const PIA = "6f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d6e";
const binding: NonceBinding = {
  userId: PIA,
  sessionId: "session-1",
  digest: actionDigest("members.change_role", { userId: "lee", role: "admin" }),
};

const later = (seconds: number) => new Date(ISSUED.getTime() + seconds * 1000);

describe("a confirmation nonce", () => {
  it("carries 32 random bytes and when it expires, and is signed", () => {
    const nonce = issueConfirmationNonce(SECRET, binding, { now: ISSUED });
    const [random = "", expires = "", signature = "", ...rest] = nonce.split(".");
    expect(rest).toEqual([]);
    expect(Buffer.from(random, "base64url").byteLength).toBe(32);
    expect(Number(expires)).toBe(ISSUED.getTime() / 1000 + CONFIRMATION_NONCE_TTL_SECONDS);
    expect(CONFIRMATION_NONCE_TTL_SECONDS).toBe(300);
    expect(Buffer.from(signature, "base64url").byteLength).toBe(32);
    expect(issueConfirmationNonce(SECRET, binding, { now: ISSUED })).not.toBe(nonce);
  });

  it("is valid for its user, session and action until 5 minutes after it was issued", () => {
    const nonce = issueConfirmationNonce(SECRET, binding, { now: ISSUED });
    const checked = checkConfirmationNonce(SECRET, nonce, binding, later(299));
    expect(checked).toEqual({ id: expect.stringMatching(/^[0-9a-f]{64}$/), expiresAt: later(300) });
    expect(checkConfirmationNonce(SECRET, nonce, binding, ISSUED)?.id).toBe(checked?.id);
  });

  it("has expired 5 minutes after it was issued", () => {
    const nonce = issueConfirmationNonce(SECRET, binding, { now: ISSUED });
    expect(checkConfirmationNonce(SECRET, nonce, binding, later(300))).toBeUndefined();
    expect(checkConfirmationNonce(SECRET, nonce, binding, later(360))).toBeUndefined();
  });

  it.each([
    ["another user", { userId: "a3e4b5c6-d7e8-49f0-a1b2-c3d4e5f60718" }],
    ["another session of the same user", { sessionId: "session-2" }],
    ["the same command with other input", { digest: actionDigest("members.change_role", { userId: "lee", role: "member" }) }],
    ["another command", { digest: actionDigest("members.remove", { userId: "lee", role: "admin" }) }],
  ])("is not valid for %s", (_other, change: Partial<NonceBinding>) => {
    const nonce = issueConfirmationNonce(SECRET, binding, { now: ISSUED });
    expect(checkConfirmationNonce(SECRET, nonce, { ...binding, ...change }, later(1))).toBeUndefined();
  });

  it("is not valid under another install's secret, or once changed", () => {
    const nonce = issueConfirmationNonce(SECRET, binding, { now: ISSUED });
    expect(checkConfirmationNonce(`${SECRET}-other`, nonce, binding, later(1))).toBeUndefined();
    const [random = "", expires = "", signature = ""] = nonce.split(".");
    // A later expiry, which the signature does not cover.
    expect(checkConfirmationNonce(SECRET, `${random}.${Number(expires) + 600}.${signature}`, binding, later(400))).toBeUndefined();
    for (const broken of ["", "x", `${random}.${expires}`, `${random}.${expires}.${signature}.x`, `${random}.soon.${signature}`]) {
      expect(checkConfirmationNonce(SECRET, broken, binding, later(1)), broken).toBeUndefined();
    }
  });
});

describe("an action's digest", () => {
  it("covers the command and its exact input, whatever order the input's keys came in", () => {
    const digest = actionDigest("tokens.create", { scopes: ["requests:read"], expiresOn: "2026-12-01" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDigest("tokens.create", { expiresOn: "2026-12-01", scopes: ["requests:read"] })).toBe(digest);
    expect(actionDigest("tokens.create", { expiresOn: "2026-12-02", scopes: ["requests:read"] })).not.toBe(digest);
    expect(actionDigest("tokens.create", { expiresOn: "2026-12-01", scopes: ["requests:write"] })).not.toBe(digest);
    expect(actionDigest("tokens.revoke", { expiresOn: "2026-12-01", scopes: ["requests:read"] })).not.toBe(digest);
  });
});
