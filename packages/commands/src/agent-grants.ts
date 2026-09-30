import { approveAgentClient, listAgentGrants, revokeAgentGrant, SCOPES } from "@tiehall/catalog";
import { agentClientApproved, agentGrantRevoked, Refusal } from "@tiehall/core";
import { oauthAccessTokens, oauthClients, oauthConsents, oauthDeviceCodes, oauthRefreshTokens, signInVerifications } from "@tiehall/db";
import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import { REFRESH_SCOPE } from "./authorization-server.ts";
import { actsForUser, type Caller } from "./caller.ts";
import type { ConfirmRedirects } from "./confirm-route.ts";
import type { Reviews } from "./confirmation-step.ts";
import type { AgentClient } from "./agent-clients.ts";
import { authorizationRequestOf, consentReview, consentViewIn, continuePathOf } from "./consent.ts";
import { CLI_CLIENT_ID } from "./device-flow.ts";
import { defineHandler, type Handlers } from "./execute.ts";
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
// refresh gets invalid_grant, and appends its security event, together.
// Access tokens already issued stop working when they expire, within 10
// minutes.

/**
 * Stores a member's grant to an agent client, in the approval's write, with
 * the scopes and resources it approved, and appends the approval's security
 * event with it: one grant per client and member, which a later approval
 * updates. Returns the grant's id.
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
      await revokeGrant(writer, userId, grant, at);
      return { grantId };
    });
  }),
};

/** A grant as a revocation locks it: its id, the client id it is for and Tiehall's own record of that client. */
interface LockedGrant {
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
 * invalid_grant, removes their stored access tokens, and appends the security
 * event.
 */
async function revokeGrant(writer: Writer, userId: string, grant: LockedGrant, at: Date): Promise<void> {
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
  await writer.record(agentGrantRevoked, { userId, clientId: grant.clientRecord, grantId: grant.grantId });
}

/**
 * Revokes, in a removal's write, everything that lets an agent client act for
 * the removed person (teams-and-roles: Removing a member): each of their
 * grants, the tiehall CLI's included, with its security event; then any
 * refresh token or stored access token of theirs that no grant covers; the
 * device codes they approved that the CLI has not exchanged yet, which are
 * denied; and the authorization codes issued to them that no client has
 * exchanged yet, which are removed. So no client gets a token for them from
 * anything they approved before the removal.
 */
export async function revokeAgentAccessOf(writer: Writer, userId: string, at: Date): Promise<void> {
  for (const grant of await lockGrants(writer, userId)) await revokeGrant(writer, userId, grant, at);
  await writer.tx
    .update(oauthRefreshTokens)
    .set({ revoked: at })
    .where(and(eq(oauthRefreshTokens.orgId, writer.orgId), eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revoked)));
  await writer.tx.delete(oauthAccessTokens).where(and(eq(oauthAccessTokens.orgId, writer.orgId), eq(oauthAccessTokens.userId, userId)));
  await writer.tx
    .update(oauthDeviceCodes)
    .set({ status: "denied" })
    .where(and(eq(oauthDeviceCodes.orgId, writer.orgId), eq(oauthDeviceCodes.userId, userId), eq(oauthDeviceCodes.status, "approved")));
  // An authorization code is kept as the sign-in service writes it: JSON that names its type and its user.
  await writer.tx
    .delete(signInVerifications)
    .where(
      and(
        eq(signInVerifications.orgId, writer.orgId),
        like(signInVerifications.value, '%"type":"authorization_code"%'),
        like(signInVerifications.value, `%"userId":"${userId}"%`),
      ),
    );
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
