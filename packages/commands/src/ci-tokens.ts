import { createHash } from "node:crypto";
import { CONTRACT_REPORT_ID } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { usedCiTokens, type Database } from "@tiehall/db";
import { and, eq, lt } from "drizzle-orm";
import { createLocalJWKSet, createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import type { AgentTokenCheck } from "./agent-tokens.ts";
import { repositoryHasRegisteredApi } from "./apis.ts";
import { bearerTokenOf } from "./agent-tokens.ts";
import type { Caller, CiCaller } from "./caller.ts";
import { defineJobType } from "./jobs.ts";
import { createGitHubActionsFetch, GITHUB_ACTIONS_OIDC_ORIGIN, type Fetch } from "./outbound.ts";
import type { WorkerJob } from "./worker.ts";
import { SetupRequiredError, withOrg } from "./with-org.ts";

// The CI caller (agent-access: CI authenticates with GitHub Actions OIDC bound
// to registered repositories; agent-access: Six kinds of caller; public-api:
// One error model for Tiehall's own refusals; design.md, Decisions this
// change rests on: D28 #1, #44; D29 (7); design.md, Technical decisions: T7).
// The contract Action's run presents the GitHub Actions OIDC token of its run
// in the Authorization header, as a bearer token, with no token exchange and
// without the sign-in service. A call to /api/v1 whose bearer token names
// GitHub Actions as its issuer is a CI caller's, and its token is checked
// here; every other token is an agent's (agent-tokens.ts). /mcp takes no CI
// token: there it is an agent token that is not valid.
//
// The token must be signed with RS256 by a key that GitHub Actions publishes
// in its JSON Web Key Set; name GitHub Actions as its issuer
// (https://token.actions.githubusercontent.com); have exactly one audience,
// the install's URL, TIEHALL_URL, which the Action asks for; not have
// expired; and name a jti, the repository's GitHub id (repository_id), its
// owner's (repository_owner_id) and the run's workflow (job_workflow_ref).
// Any failure is refused with 401 invalid_token, as any other bearer token
// that is not valid is. The jti of every token that passes is recorded, in a
// transaction of its own, before the call goes on: a token whose jti was seen
// before, whatever became of that call, is refused with 401 invalid_token as
// replayed (D29 (7)), and of two calls that present one token at once, one
// alone goes on. A recorded jti is removed once its token has expired, after
// which no call can present it anyway.
//
// The keys are read from GitHub Actions' JSON Web Key Set, through a fetch
// that reaches only GitHub Actions' OIDC issuer, and kept for 10 minutes; a
// token signed by a key the kept set does not hold makes the check read the
// set again, at most every 30 seconds, since GitHub may have rotated its keys.
// When the set cannot be read, within 10 seconds, the call is refused with
// 502 integration-unavailable, having recorded nothing, so the same token can
// be presented again.
//
// The CI caller acts for the repository its token names, and for no user:
// neither the membership re-check nor the PAT switch applies to it. It may
// call contract.report alone, which takes a report only for an API registered
// to that repository and, for an API bound to a workflow, from that workflow,
// and from a run for a pull request, whose ref is refs/pull/<n>/merge, only
// about pull request n (apis.ts). A run in a repository that no registered API
// is bound to may call nothing at all, and any GitHub user can have a workflow
// of their own ask for a token whose audience is the install's URL.
//
// So a CI caller's call to /api/v1 is checked in this order
// (decisions-from-groups-15-28, D55 (58)), after the body's size and the
// path, which answers 404 when it serves no operation. A call to an operation
// other than contract.report is refused with 403 ci-caller-refused before the
// keys are read (createApiCallerCheck), so it never waits for GitHub or gets
// 502. Then the token itself: its signature, issuer, audience and expiry, 401
// invalid_token or 502 as above. Then a token that names a repository no
// registered API is bound to is refused with 403 ci-caller-refused, before
// anything else of its call, its body included, is judged, and its jti is not
// recorded, so the same token gets 403 again, not 401. Then a jti recorded
// before is a replay, 401 invalid_token; any other is recorded, and so spent,
// before the report itself is checked, so a report refused after that, for
// its input, its API, its workflow or its pull request, has spent its token.

/** GitHub Actions' OIDC issuer, as its tokens name it. */
export const GITHUB_ACTIONS_ISSUER = GITHUB_ACTIONS_OIDC_ORIGIN;

/** Where GitHub Actions publishes the keys that sign its OIDC tokens. */
export const GITHUB_ACTIONS_JWKS_URL = `${GITHUB_ACTIONS_OIDC_ORIGIN}/.well-known/jwks`;

/** How long reading GitHub Actions' keys may take. */
const KEYS_TIMEOUT_MS = 10_000;

/** How long a recorded jti is kept after its token expired, for a web process whose clock runs behind the worker's. */
const EXPIRED_TOKEN_GRACE_MS = 5 * 60_000;

/** A GitHub id, as GitHub Actions' claims give it: a whole number, as a string. */
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;

/** The ref a run for a pull request runs from, which names the pull request's number. */
const PULL_REQUEST_REF = /^refs\/pull\/([1-9][0-9]{0,9})\/merge$/;

export interface CiTokenCheckOptions {
  /** The install's URL (TIEHALL_URL), as its origin: the audience a token must name. */
  url: string;
  /** The app's database, where the jti of every token seen is recorded. */
  database: Database;
  /** GitHub Actions' keys, as a JSON Web Key Set; read from GITHUB_ACTIONS_JWKS_URL unless a test gives them. */
  keys?: (() => Promise<JSONWebKeySet>) | undefined;
  /** The fetch GitHub Actions' keys are read with; the platform's unless a test gives another. It reaches no other host. */
  fetch?: Fetch | undefined;
  /** The clock tokens expire by; the system clock unless a test controls it. */
  now?: () => Date;
}

/** The CI caller a GitHub Actions OIDC token stands for; a refusal for a token that is not valid. */
export type CiTokenCheck = (token: string) => Promise<CiCaller>;

/** The keys could not be read, so the token could not be checked: GitHub failed a call the check needs. */
class KeysUnavailable extends Error {
  override name = "KeysUnavailable";
}

function invalidToken(): Refusal {
  return new Refusal("invalid-token", "The access token is not valid: it is expired, malformed, replayed or not a GitHub Actions token for this install.");
}

/** Whether a bearer token names GitHub Actions as its issuer, which makes its call a CI caller's; nothing of it is checked yet. */
export function isGitHubActionsToken(token: string): boolean {
  try {
    return decodeJwt(token).iss === GITHUB_ACTIONS_ISSUER;
  } catch {
    return false;
  }
}

export function createCiTokenCheck(options: CiTokenCheckOptions): CiTokenCheck {
  const now = options.now ?? (() => new Date());
  const { keys } = options;
  const source: JWTVerifyGetKey =
    keys !== undefined
      ? async (header, token) => createLocalJWKSet(await keys())(header, token)
      : createRemoteJWKSet(new URL(GITHUB_ACTIONS_JWKS_URL), {
          timeoutDuration: KEYS_TIMEOUT_MS,
          [customFetch]: createGitHubActionsFetch(options.fetch ?? fetch) as never,
        });
  // A key the set does not hold is the token's fault; a set that cannot be read is GitHub's.
  const getKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await source(header, token);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS") throw error;
      throw new KeysUnavailable("GitHub Actions' keys could not be read.");
    }
  };

  return async function checkCiToken(token) {
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, getKey, {
        issuer: GITHUB_ACTIONS_ISSUER,
        audience: options.url,
        algorithms: ["RS256"],
        currentDate: now(),
        requiredClaims: ["exp", "jti"],
      }));
    } catch (error) {
      if (error instanceof KeysUnavailable) {
        throw new Refusal("integration-unavailable", "Tiehall could not read the keys of GitHub Actions to check this CI run's token. Try again later.");
      }
      if (isJoseError(error)) throw invalidToken();
      throw error;
    }
    // Exactly one audience, the install's own.
    const audience = claims["aud"];
    if (!(audience === options.url || (Array.isArray(audience) && audience.length === 1 && audience[0] === options.url))) throw invalidToken();
    const { jti, repository_id: repositoryId, repository_owner_id: repositoryOwnerId, job_workflow_ref: jobWorkflowRef, ref, exp } = claims;
    if (typeof jti !== "string" || jti.length === 0 || jti.length > 255) throw invalidToken();
    if (typeof repositoryId !== "string" || !GITHUB_ID.test(repositoryId)) throw invalidToken();
    if (typeof repositoryOwnerId !== "string" || !GITHUB_ID.test(repositoryOwnerId)) throw invalidToken();
    if (typeof jobWorkflowRef !== "string" || jobWorkflowRef.length === 0 || jobWorkflowRef.length > 1024) throw invalidToken();
    if (typeof exp !== "number") throw invalidToken();
    if (ref !== undefined && typeof ref !== "string") throw invalidToken();
    // A run for a pull request runs from the pull request's merge ref, which names it.
    const pullRequest = PULL_REQUEST_REF.exec(ref ?? "")?.[1];
    const outcome = await withOrg(options.database, async (context) => {
      // A run in a repository that no registered API is bound to may call nothing.
      if (!(await repositoryHasRegisteredApi(context, { repositoryId, repositoryOwnerId }))) return "unregistered";
      // A jti seen before is a replay, whatever became of the call that presented it first.
      const recorded = await context.tx
        .insert(usedCiTokens)
        .values({ orgId: context.orgId, jtiHash: createHash("sha256").update(jti).digest(), expiresAt: new Date(exp * 1000) })
        .onConflictDoNothing()
        .returning({ orgId: usedCiTokens.orgId });
      return recorded.length === 0 ? "replayed" : "recorded";
    });
    if (outcome === "unregistered") {
      throw new Refusal("ci-caller-refused", "No API is registered to this CI run's repository, so it may not call Tiehall.");
    }
    if (outcome === "replayed") throw invalidToken();
    return { kind: "ci", repositoryId, repositoryOwnerId, jobWorkflowRef, ...(pullRequest === undefined ? {} : { pullRequest: Number(pullRequest) }) };
  };
}

/** Whether a failure of the check is the token's: a JOSE error, such as a malformed token, a bad signature, a wrong claim or an expired token. */
function isJoseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return error instanceof Error && typeof code === "string" && (code.startsWith("ERR_JW") || code.startsWith("ERR_JOSE"));
}

/** Who a call to /api/v1 acts for, given the operation its path serves. */
export type ApiCallerCheck = (request: Request, operation: { id: string }) => Promise<Caller | undefined>;

/**
 * Who a call to /api/v1 acts for, from the bearer token in its Authorization
 * header: a CI caller for a token that names GitHub Actions as its issuer, and
 * otherwise whom the agent token check says. A CI caller's call to any
 * operation but contract.report is refused before its token is checked, so
 * before GitHub Actions' keys are read.
 */
export function createApiCallerCheck(checks: { agent: AgentTokenCheck; ci: CiTokenCheck }): ApiCallerCheck {
  return async (request, operation) => {
    const token = bearerTokenOf(request);
    if (token !== undefined && isGitHubActionsToken(token)) {
      if (operation.id !== CONTRACT_REPORT_ID) throw new Refusal("ci-caller-refused", "A CI caller may only report contract changes.");
      return checks.ci(token);
    }
    return checks.agent(request);
  };
}

/** Deletes the recorded jti of every token that expired more than a few minutes ago, by the worker's clock, every hour. */
export const pruneUsedCiTokens: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("ci.prune_used_tokens", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "53 * * * *",
  async handle(_job, { database, now }) {
    const cutoff = new Date(now().getTime() - EXPIRED_TOKEN_GRACE_MS);
    try {
      await withOrg(database, ({ tx, orgId }) => tx.delete(usedCiTokens).where(and(eq(usedCiTokens.orgId, orgId), lt(usedCiTokens.expiresAt, cutoff))));
    } catch (error) {
      // Before setup no CI run can report, and so no token is recorded.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};
