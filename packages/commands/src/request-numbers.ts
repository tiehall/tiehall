import { requestCounters } from "@tiehall/db";
import { sql } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// Per-team request numbers (requests: Per-team request keys; design.md, Design
// rules: Requests and events). A request's key is its target team's key, a
// hyphen and its number in that team's count, such as FE-142. The transaction
// that creates the request takes the number here, inside itself: the team's
// count row stays locked until that transaction ends, so a concurrent create
// for the same team waits, and numbers never repeat within a team. A create
// that rolls back takes its number back with it, so the next create gets it
// and no stored number is ever skipped or used twice. Each team has its own
// row, so a create for one team never waits on another team's.

/** Takes the team's next request number, locking its count until the transaction ends. */
export async function takeRequestNumber({ tx, orgId }: OrgContext, teamId: string): Promise<number> {
  // The team's first request creates its row; a create that races it waits on the row, then counts on.
  const [taken] = await tx
    .insert(requestCounters)
    .values({ orgId, teamId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [requestCounters.orgId, requestCounters.teamId],
      set: { lastNumber: sql`${requestCounters.lastNumber} + 1` },
    })
    .returning({ number: requestCounters.lastNumber });
  if (taken === undefined) throw new Error("The team's request count returned no number.");
  return taken.number;
}
