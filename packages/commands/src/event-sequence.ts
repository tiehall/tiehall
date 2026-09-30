import { sql } from "drizzle-orm";
import { eventSequence } from "@tiehall/db";
import type { OrgContext } from "./with-org.ts";

// The event sequence (requests: The event log; design.md, Technical decisions:
// T5). Every event takes its number here, inside the transaction that writes
// it. The org's counter row stays locked until that transaction ends, so the
// next writer waits: numbers follow commit order, and a reader that has seen
// event N never later finds an unseen event numbered N or lower. A rolled-back
// transaction takes its number back with it, so the sequence has no gaps.
// A plain sequence or bigserial would hand out numbers without waiting, and a
// reader could pass an event that commits late.
//
// The lock order. Every write holds the counter from its first event until it
// commits, so a write that locked a row after its first event could wait,
// holding the counter, for a write that holds that row and waits for the
// counter: a deadlock, and a 500 for one of them. So a write takes every row
// lock it needs before its first record(), and every write takes its locks in
// this one order, so that two at once wait in a line and never on each other:
// 1. the members' rows a change to who is a member locks (member-changes.ts),
//    and the member's own row, FOR KEY SHARE, that a write giving them a
//    credential, a personal access token or an agent grant, locks first
//    (with-org.ts), so a removal of that member waits for it or it for the
//    removal;
// 2. the records of the GitHub organizations Tiehall saw those members in
//    (member_organizations), which every writer changes only once it holds
//    the member's row, and not at all once the member is gone: a departure
//    check that records the organizations reporting a member
//    (organization-departures.ts), a join through organization membership,
//    which inserts the member's row first (sign-in-admission.ts), and a
//    removal, whose delete of the member's row takes the records with it
//    (member-changes.ts);
// 3. the request's row (request-changes.ts), or, for a write on several
//    requests, such as a removal or the expiry job, their rows in the order
//    of their ids;
// 4. the request's proposals: its pending ones, oldest first, then the one
//    the call names, then the record of what its commitment replaced
//    (proposals.ts, proposal-confirmations.ts, proposal-undo.ts);
// 5. a person's credentials: their agent grants, then the rows those grants
//    and their personal access tokens stand for, the refresh and access
//    tokens, the device codes, the authorization codes and the tokens
//    themselves. A removal revokes them all before its first event
//    (agent-grants.ts, personal-access-tokens.ts); a person's own revocation
//    locks the one grant or token it revokes first;
// 6. what a write counts or numbers before its first event: an agent token's
//    writes (write-limits.ts), the loop limit's re-lock of the request's row
//    (loop-limit.ts) and a team's next request number (request-numbers.ts);
// 7. the org's event counter, here, with the first event: the last lock a
//    write takes. What a write does after its first event, such as cancelling
//    the proposals its change ends, locks only rows it holds already.
// packages/commands/test/proposal-locks.test.ts,
// member-organization-locks.test.ts and member-removal-races.test.ts run the
// pairs of writes that once waited on each other, in both orders.

/** Takes the next event number of the org, locking its counter row until the transaction ends. */
export async function takeEventNumber({ tx, orgId }: OrgContext): Promise<number> {
  // The first event of the org creates its counter row; a writer that races it waits on the row, then counts on.
  const [taken] = await tx
    .insert(eventSequence)
    .values({ orgId, lastNumber: 1 })
    .onConflictDoUpdate({ target: eventSequence.orgId, set: { lastNumber: sql`${eventSequence.lastNumber} + 1` } })
    .returning({ number: eventSequence.lastNumber });
  if (taken === undefined) throw new Error("The event sequence returned no number.");
  return taken.number;
}
