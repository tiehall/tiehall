import { orgs, type Database, type Transaction } from "@tiehall/db";

// withOrg() (teams-and-roles: One org per install; design.md, Technical
// decisions: T3 and Self-hosting decisions: S1) is the only way a handler
// reaches the database: execute() runs each handler inside it. It opens one
// transaction for the install's one org and hands the handler that org's id, so
// every row the handler writes carries it. v1 has no tenant layer, so it sets
// no row-level-security setting. Task 9.2 adds the membership re-check.

export interface OrgContext {
  /** The transaction the handler runs in: it commits when the handler returns and rolls back when it throws. */
  tx: Transaction;
  /** The id of the install's org. */
  orgId: string;
}

/** The install has no org yet, because setup has not named it; callers answer 503 `setup-required`. */
export class SetupRequiredError extends Error {
  override name = "SetupRequiredError";
  constructor() {
    super("Setup is not complete: the install has no org yet.");
  }
}

export async function withOrg<T>(database: Database, handler: (context: OrgContext) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    const [org] = await tx.select({ id: orgs.id }).from(orgs).limit(1);
    if (org === undefined) throw new SetupRequiredError();
    return handler({ tx, orgId: org.id });
  });
}
