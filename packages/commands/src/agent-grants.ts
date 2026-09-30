import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { approveAgentClient, listAgentGrants, revokeAgentGrant, SCOPES } from "@tiehall/catalog";
import { agentClientApproved, agentGrantRevoked, Refusal } from "@tiehall/core";
import { members, oauthAccessTokens, oauthClients, oauthConsents, oauthDeviceCodes, oauthRefreshTokens, signInVerifications, type Database } from "@tiehall/db";
import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { REFRESH_SCOPE } from "./authorization-server.ts";
import { actsForUser, type Caller } from "./caller.ts";
import type { ConfirmRedirects } from "./confirm-route.ts";
import type { Reviews } from "./confirmation-step.ts";
import type { AgentClient } from "./agent-clients.ts";
import { authorizationRequestOf, consentReview, consentViewIn, continuePathOf } from "./consent.ts";
import { CLI_CLIENT_ID } from "./device-flow.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { lockMembership, withOrg } from "./with-org.ts";
import type { Writer } from "./write.ts";

// A member's grants to agent clients (agent-access: Approving an agent client
// uses the confirmation step; agent-access: Users list and revoke their own
// agent grants and tokens; activity-log: Which actions are security events;
// activity-log: Writes the sign-in service owns are still recorded; design.md,
// Technical decisions: T8; design.md, Self-hosting decisions: S7 and S14).
//
// Approving an agent client is an action that needs the confirmation step: the
// consent screen is its review page (consent.ts), whose nonce is bound to the
// signed-in member, their web session and this one authorization request.
// The sign-in service's own consent route is not served over HTTP; this
// command replaces it, as design.md's T8 allows for a route that changes who
// may do what. Confirmed, it stores the grant the authorization server reads,
// for the approving member, with the scopes and the resource the client asked
// for and the refresh scope the server issues refresh tokens with, and
// appends its security event in the same transaction, so the grant is never
// without its event; the browser then goes back to the authorization, which
// gives the client its code for that member. Approving the same client again
// updates the one grant.
//
// A member lists their own grants on their Connected agents and tokens page:
// for each, who the client says it is, whether it is the tiehall CLI, whether
// its identity is verified, what it may do and when the member approved it.
//
// Revoking a grant needs no confirmation step, since it only takes access
// away, but runs only in the web UI, for the member whose grant it is (404 for
// any other, as for a grant that does not exist). It removes the grant, marks
// every refresh token of that client for that member revoked, so the next
// refresh gets invalid_grant, removes the authorization codes the client was
// given for that member and has not exchanged, denies the device codes the
// member approved for it that it has not exchanged, and appends its security
// event, together. Access tokens already issued stop working when they expire,
// within 10 minutes.
//
// The token endpoint gives tokens only from a grant that still exists: after
// the authorization server has issued them, a check locks the member's row and
// the grant's, so a removal or a revocation under way commits first, and when
// the person is no longer a member or the grant is gone, it revokes what was
// just issued and every other refresh token of that client for that person,
// and answers invalid_grant instead. So a code or a refresh token a client
// exchanges while its grant is revoked, or its person removed, leaves it no
// token, and no refresh token that the Connected agents and tokens page could
// no longer show.

/**
 * Stores a member's grant to an agent client, in the approval's write, with
 * the scopes and resources it approved, and appends the approval's security
 * event with it: one grant per client and member, which a later approval
 * updates. Returns the grant's id. The write has locked the member's own
 * membership row first (with-org.ts), so a removal cannot miss the grant.
 */
export async function storeGrant(
  writer: Writer,
  grant: { client: Pick<AgentClient, "id" | "clientId">; userId: string; scopes: readonly string[]; resources: readonly string[]; at: Date },
): Promise<string> {
  const { client, userId, at } = grant;
  const scopes = [...grant.scopes];
  const resources = [...grant.resources];
  // One grant per client and member: two approvals at once update the same one.
  await writer.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tiehall.agent_grant:${client.clientId}:${userId}`}, 0))`);
  const [existing] = await writer.tx
    .select({ id: oauthConsents.id })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.orgId, writer.orgId), eq(oauthConsents.clientId, client.clientId), eq(oauthConsents.userId, userId)));
  let grantId: string;
  if (existing !== undefined) {
    grantId = existing.id;
    await writer.tx
      .update(oauthConsents)
      .set({ scopes, resources, requestedUserInfoClaims: [], updatedAt: at })
      .where(and(eq(oauthConsents.orgId, writer.orgId), eq(oauthConsents.id, grantId)));
  } else {
    const [created] = await writer.tx
      .insert(oauthConsents)
      .values({ orgId: writer.orgId, clientId: client.clientId, userId, scopes, resources, requestedUserInfoClaims: [], createdAt: at, updatedAt: at })
      .returning({ id: oauthConsents.id });
    grantId = created?.id ?? "";
  }
  await writer.record(agentClientApproved, { userId, clientId: client.id, grantId });
  return grantId;
}

/** The member a web UI call acts for; the confirmation step and the web UI run only for one. */
export function memberOf(caller: Caller): string {
  if (!actsForUser(caller)) throw new Refusal("forbidden", "Only a signed-in member approves or revokes an agent client.");
  return caller.userId;
}

export const AGENT_GRANT_HANDLERS: Handlers = {
  [approveAgentClient.id]: defineHandler(approveAgentClient, async ({ authorization }, context) => {
    const userId = memberOf(context.caller);
    const request = authorizationRequestOf(new URLSearchParams(authorization));
    const { client } = await consentViewIn(context, request);
    if (request.scopes.length === 0 || request.scopes.some((scope) => !(SCOPES as readonly string[]).includes(scope))) {
      throw new Refusal("invalid-input", `An agent client asks for one or more of ${SCOPES.join(", ")}, and for nothing else.`);
    }
    const scopes = [...request.scopes, REFRESH_SCOPE];
    const resources = request.parameters.getAll("resource");
    const at = context.now();
    return context.write(async (writer) => {
      // A removal of the member under way commits first, and this one is refused, or waits for this one and revokes the grant.
      await lockMembership(writer, userId);
      const grantId = await storeGrant(writer, { client, userId, scopes, resources, at });
      return { grantId, continue: continuePathOf(new URLSearchParams(authorization)) };
    });
  }),

  [listAgentGrants.id]: defineHandler(listAgentGrants, async (_input, context) => {
    const userId = memberOf(context.caller);
    const rows = await context.tx
      .select({
        id: oauthConsents.id,
        clientId: oauthClients.clientId,
        name: oauthClients.name,
        discovery: oauthClients.clientDiscoveryId,
        scopes: oauthConsents.scopes,
        createdAt: oauthConsents.createdAt,
        updatedAt: oauthConsents.updatedAt,
      })
      .from(oauthConsents)
      .innerJoin(oauthClients, and(eq(oauthClients.orgId, oauthConsents.orgId), eq(oauthClients.clientId, oauthConsents.clientId)))
      .where(and(eq(oauthConsents.orgId, context.orgId), eq(oauthConsents.userId, userId)))
      .orderBy(asc(oauthConsents.createdAt), asc(oauthConsents.id));
    return {
      grants: rows.map((row) => {
        const verifiedHost = row.discovery === "cimd" ? hostOf(row.clientId) : undefined;
        return {
          id: row.id,
          client: { name: row.name ?? null, cli: row.clientId === CLI_CLIENT_ID, verifiedHost: verifiedHost ?? null, unverified: verifiedHost === undefined && row.clientId !== CLI_CLIENT_ID },
          scopes: row.scopes.filter((scope) => scope !== REFRESH_SCOPE),
          approvedAt: (row.updatedAt ?? row.createdAt ?? new Date(0)).toISOString(),
        };
      }),
    };
  }),

  [revokeAgentGrant.id]: defineHandler(revokeAgentGrant, async ({ grantId }, context) => {
    const userId = memberOf(context.caller);
    const at = context.now();
    return context.write(async (writer) => {
      const [grant] = await lockGrants(writer, userId, grantId);
      if (grant === undefined) throw new Refusal("record-not-found", "You hold no agent grant with this id.");
      await removeGrant(writer, userId, grant, at);
      await recordGrantRevocations(writer, userId, [grant]);
      return { grantId };
    });
  }),
};

/** A grant as a revocation locks it: its id, the client id it is for and Tiehall's own record of that client. */
export interface LockedGrant {
  grantId: string;
  clientId: string;
  clientRecord: string;
}

/** Locks the user's grants, or the one with this id, in the writer's transaction. */
function lockGrants(writer: Writer, userId: string, grantId?: string): Promise<LockedGrant[]> {
  return writer.tx
    .select({ grantId: oauthConsents.id, clientId: oauthConsents.clientId, clientRecord: oauthClients.id })
    .from(oauthConsents)
    .innerJoin(oauthClients, and(eq(oauthClients.orgId, oauthConsents.orgId), eq(oauthClients.clientId, oauthConsents.clientId)))
    .where(
      and(
        eq(oauthConsents.orgId, writer.orgId),
        eq(oauthConsents.userId, userId),
        ...(grantId === undefined ? [] : [eq(oauthConsents.id, grantId)]),
      ),
    )
    .orderBy(asc(oauthConsents.createdAt), asc(oauthConsents.id))
    .for("update", { of: oauthConsents });
}

/**
 * Revokes one grant in the writer's transaction: removes it, marks every
 * refresh token of its client for the user revoked, so the next refresh gets
 * invalid_grant, removes their stored access tokens, denies the device codes
 * the user approved for the client and removes the authorization codes issued
 * to it for them that were not exchanged yet. Its security event follows,
 * once the write has changed every row it changes (recordGrantRevocations()).
 */
async function removeGrant(writer: Writer, userId: string, grant: LockedGrant, at: Date): Promise<void> {
  await writer.tx.delete(oauthConsents).where(and(eq(oauthConsents.orgId, writer.orgId), eq(oauthConsents.id, grant.grantId)));
  await writer.tx
    .update(oauthRefreshTokens)
    .set({ revoked: at })
    .where(
      and(
        eq(oauthRefreshTokens.orgId, writer.orgId),
        eq(oauthRefreshTokens.clientId, grant.clientId),
        eq(oauthRefreshTokens.userId, userId),
        isNull(oauthRefreshTokens.revoked),
      ),
    );
  await writer.tx
    .delete(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.orgId, writer.orgId), eq(oauthAccessTokens.clientId, grant.clientId), eq(oauthAccessTokens.userId, userId)));
  await writer.tx
    .update(oauthDeviceCodes)
    .set({ status: "denied" })
    .where(
      and(
        eq(oauthDeviceCodes.orgId, writer.orgId),
        eq(oauthDeviceCodes.userId, userId),
        eq(oauthDeviceCodes.oauthClientId, grant.clientId),
        eq(oauthDeviceCodes.status, "approved"),
      ),
    );
  await deleteUnexchangedCodes(writer, userId, grant.clientId);
}

/** Appends the security event of each grant the write revoked, in the order it locked them. */
export async function recordGrantRevocations(writer: Writer, userId: string, grants: readonly LockedGrant[]): Promise<void> {
  for (const grant of grants) await writer.record(agentGrantRevoked, { userId, clientId: grant.clientRecord, grantId: grant.grantId });
}

/**
 * Removes the authorization codes issued for the user that no client has
 * exchanged yet, or only those issued to one client. A code is kept as the
 * sign-in service writes it: JSON that names its type, its user and, in the
 * request it answers, its client.
 */
async function deleteUnexchangedCodes(writer: Writer, userId: string, clientId?: string): Promise<void> {
  const codes = await writer.tx
    .select({ id: signInVerifications.id, value: signInVerifications.value })
    .from(signInVerifications)
    .where(
      and(
        eq(signInVerifications.orgId, writer.orgId),
        like(signInVerifications.value, '%"type":"authorization_code"%'),
        like(signInVerifications.value, `%"userId":"${userId}"%`),
      ),
    );
  const ids = codes.filter(({ value }) => clientId === undefined || clientOfCode(value) === clientId).map(({ id }) => id);
  if (ids.length > 0) await writer.tx.delete(signInVerifications).where(and(eq(signInVerifications.orgId, writer.orgId), inArray(signInVerifications.id, ids)));
}

/** The client an authorization code was issued to, as its stored request names it. */
function clientOfCode(value: string): string | undefined {
  try {
    const clientId = (JSON.parse(value) as { query?: { client_id?: unknown } }).query?.client_id;
    return typeof clientId === "string" ? clientId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revokes, in a removal's write, everything that lets an agent client act for
 * the removed person (teams-and-roles: Removing a member): each of their
 * grants, the tiehall CLI's included; then any refresh token or stored access
 * token of theirs that no grant covers; the device codes they approved that
 * the CLI has not exchanged yet, which are denied; and the authorization codes
 * issued to them that no client has exchanged yet, which are removed. So no
 * client gets a token for them from anything they approved before the
 * removal. It appends no event: it returns the grants it revoked, whose
 * events the removal appends once it has changed every row it changes, since
 * a write takes every row lock it needs before its first event
 * (event-sequence.ts).
 */
export async function revokeAgentAccessOf(writer: Writer, userId: string, at: Date): Promise<LockedGrant[]> {
  const grants = await lockGrants(writer, userId);
  for (const grant of grants) await removeGrant(writer, userId, grant, at);
  await writer.tx
    .update(oauthRefreshTokens)
    .set({ revoked: at })
    .where(and(eq(oauthRefreshTokens.orgId, writer.orgId), eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revoked)));
  await writer.tx.delete(oauthAccessTokens).where(and(eq(oauthAccessTokens.orgId, writer.orgId), eq(oauthAccessTokens.userId, userId)));
  await writer.tx
    .update(oauthDeviceCodes)
    .set({ status: "denied" })
    .where(and(eq(oauthDeviceCodes.orgId, writer.orgId), eq(oauthDeviceCodes.userId, userId), eq(oauthDeviceCodes.status, "approved")));
  await deleteUnexchangedCodes(writer, userId);
  return grants;
}

/** The digest the authorization server keeps of an opaque token: SHA-256, base64url without padding. */
function storedTokenOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** The user and the client an answer of the token endpoint issued its access token for; undefined for one it cannot read. */
async function holderOf(database: Database, accessToken: string): Promise<{ userId: string; clientId: string } | undefined> {
  const parts = accessToken.split(".");
  if (parts.length === 3) {
    try {
      // The token was signed a moment ago by this install's own key: only who it is for is read here.
      const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
      const userId = claims["sub"];
      const clientId = claims["azp"] ?? claims["client_id"];
      return typeof userId === "string" && typeof clientId === "string" ? { userId, clientId } : undefined;
    } catch {
      return undefined;
    }
  }
  const [row] = await withOrg(database, ({ tx, orgId }) =>
    tx
      .select({ userId: oauthAccessTokens.userId, clientId: oauthAccessTokens.clientId })
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.orgId, orgId), eq(oauthAccessTokens.token, storedTokenOf(accessToken)))),
  );
  return row?.userId === undefined || row.userId === null ? undefined : { userId: row.userId, clientId: row.clientId };
}

export interface GrantCheckOptions {
  /** The app's database, as the app role. */
  database: Database;
}

/**
 * The check after the token endpoint: tokens only for a member, from a grant
 * that still exists. It locks the member's row and the grant's, so that a
 * removal or a revocation under way commits first; when either is gone, it
 * revokes the refresh tokens of that client for that person, the ones just
 * issued included, removes their stored access tokens, and answers
 * invalid_grant instead of the tokens.
 */
export function grantChecks(options: GrantCheckOptions): BetterAuthPlugin {
  return {
    id: "tiehall-grant-checks",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/oauth2/token",
          handler: createAuthMiddleware(async (context) => {
            const accessToken = (context.context.returned as { access_token?: unknown } | undefined)?.access_token;
            if (typeof accessToken !== "string") return;
            const holder = await holderOf(options.database, accessToken);
            if (holder === undefined) throw new Error("The token endpoint issued an access token whose user and client cannot be read.");
            const { userId, clientId } = holder;
            const granted = await withOrg(options.database, async ({ tx, orgId }) => {
              const [member] = await tx
                .select({ userId: members.userId })
                .from(members)
                .where(and(eq(members.orgId, orgId), eq(members.userId, userId)))
                .for("key share");
              const [grant] = await tx
                .select({ id: oauthConsents.id })
                .from(oauthConsents)
                .where(and(eq(oauthConsents.orgId, orgId), eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
                .for("key share");
              if (member !== undefined && grant !== undefined) return true;
              await tx
                .update(oauthRefreshTokens)
                .set({ revoked: new Date() })
                .where(
                  and(
                    eq(oauthRefreshTokens.orgId, orgId),
                    eq(oauthRefreshTokens.userId, userId),
                    eq(oauthRefreshTokens.clientId, clientId),
                    isNull(oauthRefreshTokens.revoked),
                  ),
                );
              await tx
                .delete(oauthAccessTokens)
                .where(and(eq(oauthAccessTokens.orgId, orgId), eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId)));
              return false;
            });
            if (!granted) {
              throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "The grant this request comes from was revoked." });
            }
          }),
        },
      ],
    },
  };
}

/** The host of a metadata-document client's id, its document's URL. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The consent screen is the review page of an approval: who is asking and what for, in Tiehall's own words. */
export const AGENT_GRANT_REVIEWS: Reviews = {
  [approveAgentClient.id]: async (input, context) => {
    const { authorization } = input as { authorization: string };
    return consentReview(await consentViewIn(context, authorizationRequestOf(new URLSearchParams(authorization))));
  },
};

/** A confirmed approval sends the browser back to the authorization, which gives the client its code. */
export const AGENT_GRANT_REDIRECTS: ConfirmRedirects = {
  [approveAgentClient.id]: (output) => (output as { continue: string }).continue,
};
