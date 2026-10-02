import { verifyJwsAccessToken } from "better-auth/oauth2";
import { SCOPES, type Scope } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { mcpResourceOf } from "./authorization-server.ts";
import type { Database } from "@tiehall/db";
import type { Caller } from "./caller.ts";
import { CLI_CLIENT_ID } from "./device-flow.ts";
import { findPersonalAccessToken, isPersonalAccessToken, personalAccessTokenCaller } from "./personal-access-tokens.ts";
import { RemovedMemberError } from "./with-org.ts";

// The access tokens agents call /api/v1 with (agent-access: Tiehall is the
// authorization server for agent clients; agent-access: Six kinds of caller;
// design.md, Design rules: Agent access; design.md, Technical decisions: T7
// and T9). A call names who it acts for with an access token in its
// Authorization header, as `Bearer <token>`; a call without one names no one.
// A token the install issued is a JWT of the type at+jwt, signed with one of
// the install's own keys, issued by the install's URL, TIEHALL_URL, for its
// one protected resource, TIEHALL_URL/mcp, as its audience, and not expired;
// a token bound to a DPoP key is not a bearer token, and is refused. It acts for its subject, the user who approved the client, through
// the client that holds it, within the three OAuth scopes it carries. Any
// other token is refused with 401 and invalid_token.
//
// Checking a token makes no outbound call: the install's public keys are read
// in the same process, from the sign-in service, and kept for a few minutes;
// a token signed with a key they do not hold makes the check read them again,
// since a key the service made since then may have signed it.
//
// A bearer token that starts with th_pat_ is a personal access token
// (agent-access: Personal access tokens are scoped, expiring and created in
// the web UI; personal-access-tokens.ts): it is looked up by its digest in the
// install's database, and acts for the user who created it, within its
// scopes; one that is unknown, expired or revoked is refused with 401 and
// invalid_token, like any other token that is not valid, except that a
// revoked or expired token of a person who is not a member now is refused with
// 403, as every call for a removed member is (teams-and-roles: Removing a
// member). An access token's caller carries when it was issued, which the
// call's membership re-check compares with when the user's membership began.
// A call with a token of the CLI's client came through the CLI, whose device
// flow alone issues one, so what it changes is recorded on the surface `cli`;
// any other token's call to /api/v1 on `api` (requests: Provenance is stamped
// by the server).

/** The install's public signing keys, as a JSON Web Key Set. */
export interface SigningKeys {
  keys: readonly Record<string, unknown>[];
}

export interface AgentTokenCheckOptions {
  /** The install's URL (TIEHALL_URL), as its origin: the issuer of the tokens it accepts. */
  url: string;
  /** Reads the install's public signing keys in the same process; undefined while the install has none. */
  signingKeys(): Promise<SigningKeys | undefined>;
  /** The clock tokens expire by; the system clock unless a test controls it. */
  now?: () => Date;
  /** The app's database, where personal access tokens are looked up by their digest; without it, every one is refused. */
  database?: Database;
}

/** Who a call's access token acts for: undefined for a call without one; a refusal for a token that is not valid. */
export type AgentTokenCheck = (request: Request) => Promise<Caller | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bearer token, as RFC 6750 allows its characters. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/** The bearer token in a call's Authorization header; undefined for a call without one, or with another scheme. */
export function bearerTokenOf(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  return BEARER.exec(header.trim())?.[1];
}

function invalidToken(): Refusal {
  return new Refusal("invalid-token", "The access token is not valid: it is expired, malformed or not issued by this install.");
}

export function createAgentTokenCheck(options: AgentTokenCheckOptions): AgentTokenCheck {
  const now = options.now ?? (() => new Date());
  // The key the check's cached public keys are kept under, one per check.
  const cacheKey = {};
  const signingKeys = async () => {
    const keys = await options.signingKeys();
    if (keys === undefined || keys.keys.length === 0) throw invalidToken();
    return keys as never;
  };

  return async function checkToken(request) {
    // A call without a bearer token, or with another scheme, names no access token.
    const token = bearerTokenOf(request);
    if (token === undefined) return undefined;
    if (isPersonalAccessToken(token)) {
      const found = options.database === undefined ? undefined : await findPersonalAccessToken(options.database, token, now());
      if (found === undefined) throw invalidToken();
      // A removed person's token is refused as theirs is while they are not a member; once they are again, as revoked.
      if (!found.usable) throw found.member ? invalidToken() : new RemovedMemberError();
      return personalAccessTokenCaller(found);
    }
    // A token that is not a JWT at all is refused before any key is read.
    if (!isJwt(token)) throw invalidToken();
    let claims: Record<string, unknown>;
    try {
      claims = await verifyJwsAccessToken(token, {
        jwksFetch: signingKeys,
        jwksCacheKey: cacheKey,
        verifyOptions: { issuer: options.url, audience: mcpResourceOf(options.url), typ: "at+jwt", currentDate: now() },
      });
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (isTokenError(error)) throw invalidToken();
      throw error;
    }
    // A token bound to a key (DPoP, RFC 9449) is good only with a proof of that key, which /api/v1 does not take.
    if (claims["cnf"] !== undefined) throw invalidToken();
    const userId = claims["sub"];
    const clientId = claims["azp"] ?? claims["client_id"];
    if (typeof userId !== "string" || !UUID.test(userId) || typeof clientId !== "string" || clientId === "") throw invalidToken();
    const granted = typeof claims["scope"] === "string" ? claims["scope"].split(" ") : [];
    const scopes = SCOPES.filter((scope): scope is Scope => granted.includes(scope));
    const issuedAt = typeof claims["iat"] === "number" ? new Date(claims["iat"] * 1000) : undefined;
    // Only the CLI holds a token of its client, from its device flow, so a call with one came through the CLI.
    const surface = clientId === CLI_CLIENT_ID ? "cli" : "api";
    return { kind: "oauth_token", userId, clientId, scopes, surface, ...(issuedAt === undefined ? {} : { issuedAt }) };
  };
}

/** Whether a token has the form of a signed JWT: three base64url parts, whose first is a JSON object that names an algorithm. */
function isJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"));
    return typeof header === "object" && header !== null && typeof (header as { alg?: unknown }).alg === "string";
  } catch {
    return false;
  }
}

/** Whether a failure of the check is the token's: a JOSE error, such as a malformed token, a bad signature, a wrong claim or an expired token. */
function isTokenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_J");
}
