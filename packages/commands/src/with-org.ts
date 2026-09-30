import { Refusal } from "@tiehall/core";
import { installSettings, members, orgs, type Database, type Transaction } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { memberOf, type Member } from "./members.ts";

// withOrg() (teams-and-roles: One org per install; design.md, Technical
// decisions: T3 and Self-hosting decisions: S1) is the only way a handler
// reaches the database: execute() runs each handler inside it. It opens one
// transaction for the install's one org and hands the handler that org's id, so
// every row the handler writes carries it. v1 has no tenant layer, so it sets
// no row-level-security setting. Until setup is complete it runs nothing, so
// no operation runs before the install has its first admin (self-host-install:
// The setup code guards the setup screen).
//
// For a call made for a user, through a web session, an OAuth token or a
// personal access token, it then re-checks, at the time of the call and before
// the handler looks anything up, that the user is still a member of the
// install, whatever session or token the call carries (teams-and-roles:
// Membership is re-checked on every call). A removal takes effect on the
// removed member's next call: it gets 403 removed-member and no data, the same
// answer whether the record it names exists or not (public-api: One error
// model for Tiehall's own refusals). The call gets the membership it read,
// with the user's role at that moment, so a role change applies from the
// user's next call too.
//
// For a call made with an access token that was issued before the user's
// current membership began, it refuses the call with 401 invalid-token: a
// removal revoked every grant the user gave, and an access token issued from
// one is revoked however long it still has to live, 10 minutes at most, when
// the user rejoins within them (teams-and-roles: Removing a member). A
// personal access token is revoked in the removal's own write.
//
// A write that gives the user a credential, a personal access token or an
// agent grant, first locks the user's own membership row (lockMembership()):
// a removal locks that row to delete it, so the two wait in a line. A removal
// that comes second finds the credential and revokes it; a write that comes
// second finds the user gone and is refused with 403 removed-member. So no
// credential made as a removal commits outlives it.
//
// For a call made with a personal access token, it then reads the install's
// PAT switch at the time of the call, and refuses the call with 403
// personal-access-tokens-off while the switch is off, before anything else
// about the call is judged (agent-access: Every token call is checked against
// the install's current state). The switch revokes nothing: once it is on
// again, the next call with an unexpired token that was never revoked goes on.

export interface OrgContext {
  /** The transaction the handler runs in: it commits when the handler returns and rolls back when it throws. */
  tx: Transaction;
  /** The id of the install's org. */
  orgId: string;
  /** For a call made for a user, their membership as the call re-checked it; undefined for a call made for no user. */
  member?: Member | undefined;
}

/**
 * Setup is not complete: the install has no org yet, or its first admin has
 * not completed setup. The error model's refusal 503 `setup-required`
 * (public-api: One error model for Tiehall's own refusals).
 */
export class SetupRequiredError extends Refusal {
  override name = "SetupRequiredError";
  constructor() {
    super("setup-required", "Setup is not complete.");
  }
}

export interface WithOrgOptions {
  /** Opens a read-only transaction, in which any write fails, such as a review page's. */
  readOnly?: boolean;
  /** The user the call is made for, through a web session or a token, whose membership is re-checked first. */
  forUser?: string | undefined;
  /** Whether the call is made with a personal access token, which the PAT switch must allow. */
  personalAccessToken?: boolean;
  /** When the call's access token was issued, which must not be before the user's current membership began. */
  issuedAt?: Date | undefined;
}

/** The call's token was issued before its user's current membership began, so a removal revoked it: 401 invalid-token. */
export class RevokedByRemovalError extends Refusal {
  override name = "RevokedByRemovalError";
  constructor() {
    super("invalid-token", "The token is not valid: it was revoked when its user was removed from the install.");
  }
}

/** Personal access tokens are switched off: the error model's 403 personal-access-tokens-off. */
export class PersonalAccessTokensOffError extends Refusal {
  override name = "PersonalAccessTokensOffError";
  constructor() {
    super("personal-access-tokens-off", "An admin has switched personal access tokens off for this install.");
  }
}

/** Whether the install's PAT switch is on, read in the caller's transaction; on until an admin turns it off. */
export async function personalAccessTokensOn({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<boolean> {
  const [row] = await tx.select({ on: installSettings.personalAccessTokensOn }).from(installSettings).where(eq(installSettings.orgId, orgId));
  return row?.on ?? true;
}

/** The caller has been removed from the install, or was never a member: the error model's 403 removed-member. */
export class RemovedMemberError extends Refusal {
  override name = "RemovedMemberError";
  constructor() {
    super("removed-member", "You are not a member of this install.");
  }
}

/**
 * Locks the user's own membership row in the caller's transaction, FOR KEY
 * SHARE, which a removal's lock of the row waits for and which makes this
 * transaction wait for a removal under way; refuses with 403 removed-member
 * when the user is not a member once the lock is held. A write that gives the
 * user a credential takes it before any other lock (event-sequence.ts).
 */
export async function lockMembership({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)))
    .for("key share");
  if (row === undefined) throw new RemovedMemberError();
}

export async function withOrg<T>(
  database: Database,
  handler: (context: OrgContext) => Promise<T>,
  options: WithOrgOptions = {},
): Promise<T> {
  return database.transaction(
    async (tx) => {
      const [org] = await tx.select({ id: orgs.id, setupCompletedAt: orgs.setupCompletedAt }).from(orgs).limit(1);
      if (org === undefined || org.setupCompletedAt === null) throw new SetupRequiredError();
      if (options.forUser === undefined) return handler({ tx, orgId: org.id });
      const member = await memberOf({ tx, orgId: org.id }, options.forUser);
      if (member === undefined) throw new RemovedMemberError();
      // Membership starts are compared to the second, as a token's issue time is recorded.
      if (options.issuedAt !== undefined && options.issuedAt.getTime() < Math.floor(member.joinedAt.getTime() / 1000) * 1000) throw new RevokedByRemovalError();
      if (options.personalAccessToken === true && !(await personalAccessTokensOn({ tx, orgId: org.id }))) throw new PersonalAccessTokensOffError();
      return handler({ tx, orgId: org.id, member });
    },
    options.readOnly === true ? { accessMode: "read only" } : undefined,
  );
}
