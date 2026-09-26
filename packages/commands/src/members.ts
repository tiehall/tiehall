import type { Role } from "@tiehall/core";
import { members } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// The members of the install (teams-and-roles: Two roles, admin and member;
// teams-and-roles: The role bounds every caller acting for a user). A user is a
// member while the install holds their membership, which carries their one
// role. Every call made for a user reads it inside the call's own
// transaction, so a role change applies from the user's next call, through
// every session and token that acts for them.

/** A member of the install, as a call made for them sees them. */
export interface Member {
  userId: string;
  role: Role;
}

/** The user's membership, read in the call's transaction; undefined when they are not a member. */
export async function memberOf({ tx, orgId }: OrgContext, userId: string): Promise<Member | undefined> {
  const [row] = await tx
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  return row === undefined ? undefined : { userId, role: row.role as Role };
}
