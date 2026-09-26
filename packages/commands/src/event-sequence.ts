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
