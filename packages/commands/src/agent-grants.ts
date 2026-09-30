import { approveAgentClient, revokeAgentGrant, SCOPES } from "@tiehall/catalog";
import { agentClientApproved, agentGrantRevoked, Refusal } from "@tiehall/core";
import { oauthAccessTokens, oauthClients, oauthConsents, oauthRefreshTokens } from "@tiehall/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { REFRESH_SCOPE } from "./authorization-server.ts";
import { actsForUser, type Caller } from "./caller.ts";
import type { ConfirmRedirects } from "./confirm-route.ts";
import type { Reviews } from "./confirmation-step.ts";
import { authorizationRequestOf, consentReview, consentViewIn, continuePathOf } from "./consent.ts";
import { defineHandler, type Handlers } from "./execute.ts";

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
// Revoking a grant needs no confirmation step, since it only takes access
// away, but runs only in the web UI, for the member whose grant it is (404 for
// any other, as for a grant that does not exist). It removes the grant, marks
// every refresh token of that client for that member revoked, so the next
// refresh gets invalid_grant, and appends its security event, together.
// Access tokens already issued stop working when they expire, within 10
// minutes.

/** The member a web UI call acts for; the confirmation step and the web UI run only for one. */
function memberOf(caller: Caller): string {
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
      return { grantId, continue: continuePathOf(new URLSearchParams(authorization)) };
    });
  }),

  [revokeAgentGrant.id]: defineHandler(revokeAgentGrant, async ({ grantId }, context) => {
    const userId = memberOf(context.caller);
    const at = context.now();
    return context.write(async (writer) => {
      const [grant] = await writer.tx
        .select({ clientId: oauthConsents.clientId, clientRecord: oauthClients.id })
        .from(oauthConsents)
        .innerJoin(oauthClients, and(eq(oauthClients.orgId, oauthConsents.orgId), eq(oauthClients.clientId, oauthConsents.clientId)))
        .where(and(eq(oauthConsents.orgId, writer.orgId), eq(oauthConsents.id, grantId), eq(oauthConsents.userId, userId)))
        .for("update", { of: oauthConsents });
      if (grant === undefined) throw new Refusal("record-not-found", "You hold no agent grant with this id.");
      await writer.tx.delete(oauthConsents).where(and(eq(oauthConsents.orgId, writer.orgId), eq(oauthConsents.id, grantId)));
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
      await writer.record(agentGrantRevoked, { userId, clientId: grant.clientRecord, grantId });
      return { grantId };
    });
  }),
};

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
