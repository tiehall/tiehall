import { createPrivateKey, createSign, createVerify, type KeyObject } from "node:crypto";

// The JSON web token a GitHub App signs with its private key to call GitHub as
// the App, as GitHub documents it: RS256, `iat` backdated against clock drift,
// `exp` at most 10 minutes ahead, and `iss` the App's client id or its id. The
// spike used the client id (spike 1.6).

export interface AppJwtOptions {
  /** The App's private key, as PEM. */
  privateKey: string | KeyObject;
  /** The App's client id or its id. */
  issuer: string | number;
  /** The signing time in seconds since the epoch; now by default. */
  now?: number;
  /** How long the token lives from `now`; 9 minutes by default. */
  lifetimeSeconds?: number;
}

/** Signs an App JWT, as a GitHub App does: `iat` 60 seconds before `now`. */
export function signAppJwt(options: AppJwtOptions): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ iat: now - 60, exp: now + (options.lifetimeSeconds ?? 540), iss: options.issuer });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const key = typeof options.privateKey === "string" ? createPrivateKey(options.privateKey) : options.privateKey;
  return `${header}.${claims}.${signer.sign(key, "base64url")}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export type JwtCheck<T> = { ok: true; app: T } | { ok: false; message: string };

// GitHub's words for a JWT it refuses. None of these were recorded by the
// spikes; they follow GitHub's answers as its documentation shows them.
const UNREADABLE = "A JSON web token could not be decoded";
const EXPIRED = "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires";
const TOO_LONG = "'Expiration time' claim ('exp') is too far in the future";
const FROM_THE_FUTURE = "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued";

/**
 * Checks an App JWT as GitHub does: an RS256 signature by one of the App's
 * keys, an `exp` in the future but no more than 10 minutes ahead, and an `iat`
 * not in the future beyond a minute of drift.
 */
export function verifyAppJwt<T>(
  token: string,
  appFor: (issuer: string) => { app: T; publicKeys: readonly KeyObject[] } | undefined,
  nowSeconds: number,
): JwtCheck<T> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, message: UNREADABLE };
  const [header, claims, signature] = parts as [string, string, string];
  let parsedHeader: { alg?: unknown };
  let parsedClaims: { iat?: unknown; exp?: unknown; iss?: unknown };
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as typeof parsedHeader;
    parsedClaims = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as typeof parsedClaims;
  } catch {
    return { ok: false, message: UNREADABLE };
  }
  if (parsedHeader.alg !== "RS256") return { ok: false, message: UNREADABLE };
  if (typeof parsedClaims.iss !== "string" && typeof parsedClaims.iss !== "number") return { ok: false, message: UNREADABLE };
  const found = appFor(String(parsedClaims.iss));
  if (found === undefined) return { ok: false, message: UNREADABLE };
  const signed = found.publicKeys.some((key) => {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    return verifier.verify(key, Buffer.from(signature, "base64url"));
  });
  if (!signed) return { ok: false, message: UNREADABLE };
  const { exp, iat } = parsedClaims;
  if (typeof exp !== "number" || exp <= nowSeconds) return { ok: false, message: EXPIRED };
  if (exp > nowSeconds + 600) return { ok: false, message: TOO_LONG };
  if (typeof iat !== "number" || !Number.isInteger(iat) || iat > nowSeconds + 60) return { ok: false, message: FROM_THE_FUTURE };
  return { ok: true, app: found.app };
}

/** Whether a bearer credential is shaped like a JWT rather than a GitHub token. */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}
