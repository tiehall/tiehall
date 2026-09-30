import { Refusal } from "@tiehall/core";
import { installSettings, orgs, type Database, type Transaction } from "@tiehall/db";
import { eq } from "drizzle-orm";
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
      if (options.personalAccessToken === true && !(await personalAccessTokensOn({ tx, orgId: org.id }))) throw new PersonalAccessTokensOffError();
      return handler({ tx, orgId: org.id, member });
    },
    options.readOnly === true ? { accessMode: "read only" } : undefined,
  );
}
