import { Refusal } from "@tiehall/core";
import { orgs, type Database, type Transaction } from "@tiehall/db";

// withOrg() (teams-and-roles: One org per install; design.md, Technical
// decisions: T3 and Self-hosting decisions: S1) is the only way a handler
// reaches the database: execute() runs each handler inside it. It opens one
// transaction for the install's one org and hands the handler that org's id, so
// every row the handler writes carries it. v1 has no tenant layer, so it sets
// no row-level-security setting. Until setup is complete it runs nothing, so
// no operation runs before the install has its first admin (self-host-install:
// The setup code guards the setup screen). Task 9.2 adds the membership
// re-check.

export interface OrgContext {
  /** The transaction the handler runs in: it commits when the handler returns and rolls back when it throws. */
  tx: Transaction;
  /** The id of the install's org. */
  orgId: string;
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
      return handler({ tx, orgId: org.id });
    },
    options.readOnly === true ? { accessMode: "read only" } : undefined,
  );
}
