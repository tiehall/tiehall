import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// The Drizzle schema of the app's tables (design.md, Technical decisions: T4).
// drizzle-kit generates the migrations in ../migrations from it with
// `pnpm --filter @tiehall/db generate --name <what-it-does>`, and a test fails
// when the two disagree. Columns name their SQL names explicitly, in snake_case.
//
// One org per install (teams-and-roles: One org per install; design.md,
// Self-hosting decisions: S1): `orgs` holds at most one row, the company the
// install serves, named on the setup screen. Every other table carries
// `org_id`, first in its primary key, such as (org_id, id), referencing orgs,
// and part of every foreign key to another table; the org id lint checks it.

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A unique index on a constant: a second row would repeat it.
  () => [uniqueIndex("orgs_one_row").on(sql`(true)`)],
);

// The event sequence (requests: The event log; design.md, Technical decisions:
// T5): one counter row per org, which the writing transaction locks to take the
// next event number. Numbers follow commit order and have no gaps.
export const eventSequence = pgTable("event_sequence", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id),
  /** The number of the last event taken, 0 before the first. */
  lastNumber: bigint("last_number", { mode: "number" }).notNull(),
});
