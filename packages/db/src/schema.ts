import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

// The event log (requests: The event log; requests: Events carry ids, not
// bodies; activity-log: The activity log holds domain events and security
// events; design.md, Technical decisions: T5). One row per event, numbered by
// the event sequence in commit order. `data` holds only the fields the event's
// type declares in packages/core: Tiehall ids, fixed values, whole numbers and
// booleans, never a body or an identifier from outside Tiehall. Who caused it:
// a user acting through an agent or a web session, the system or an
// integration (which may act for a user), or an operator command, which names
// the command and no user. The actor kind `human` is reserved and never stored.
// The app role may only insert and read events (activity-log: The activity log
// is append-only).
export const events = pgTable(
  "events",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The event's number in the org's sequence, from 1. */
    number: bigint("number", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    class: text("class").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    actorKind: text("actor_kind").notNull(),
    /** The accountable human, by their Tiehall user id. */
    actorUserId: uuid("actor_user_id"),
    /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
    client: text("client"),
    surface: text("surface"),
    /** The team the user acted for. */
    teamId: uuid("team_id"),
    operatorCommand: text("operator_command"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.number] }),
    check("events_number_positive", sql`${table.number} > 0`),
    check("events_class_known", sql`${table.class} IN ('domain', 'security')`),
    check("events_data_is_object", sql`jsonb_typeof(${table.data}) = 'object'`),
    check(
      "events_actor_kind_known",
      sql`${table.actorKind} IN ('agent', 'web_session', 'system', 'integration', 'operator')`,
    ),
    check(
      "events_surface_known",
      sql`${table.surface} IS NULL OR ${table.surface} IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')`,
    ),
    check(
      "events_actor_names_user",
      sql`${table.actorKind} NOT IN ('agent', 'web_session') OR (${table.actorUserId} IS NOT NULL AND ${table.surface} IS NOT NULL)`,
    ),
    check(
      "events_operator_names_command",
      sql`(${table.actorKind} = 'operator') = (${table.operatorCommand} IS NOT NULL) AND (${table.actorKind} <> 'operator' OR (${table.actorUserId} IS NULL AND ${table.client} IS NULL AND ${table.surface} IS NULL AND ${table.teamId} IS NULL))`,
    ),
  ],
);

/** Raw bytes, which drizzle-orm has no column type for. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// Stored integration secrets (self-host-install: Stored integration secrets are
// encrypted; design.md, Technical decisions: T4). One row per secret, such as
// the GitHub App's private key or the Jira bot's API token: its AES-256-GCM
// ciphertext with the tag, the nonce, and the id of the key that encrypted it,
// which is derived from TIEHALL_SECRET_KEY. The key itself is never stored.
export const integrationSecrets = pgTable(
  "integration_secrets",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Which secret, such as jira.api_token. */
    name: text("name").notNull(),
    keyId: text("key_id").notNull(),
    nonce: bytea("nonce").notNull(),
    /** The ciphertext followed by its 16-byte authentication tag. */
    ciphertext: bytea("ciphertext").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.name] }),
    check("integration_secrets_key_id_format", sql`${table.keyId} ~ '^[0-9a-f]{16}$'`),
    check("integration_secrets_nonce_length", sql`octet_length(${table.nonce}) = 12`),
  ],
);

// The IP address and user agent of security events, kept apart from the events
// (activity-log: IP addresses and user agents are kept apart for 90 days;
// design.md, Self-hosting decisions: S14). The write path records them with a
// security event, in its transaction; a daily job deletes them 90 days after
// their event, which stays. Only admins see them, next to the event, while they
// are kept; the export leaves them out.
export const securityEventOrigins = pgTable(
  "security_event_origins",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    eventNumber: bigint("event_number", { mode: "number" }).notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.eventNumber] }),
    foreignKey({
      name: "security_event_origins_event_fk",
      columns: [table.orgId, table.eventNumber],
      foreignColumns: [events.orgId, events.number],
    }),
  ],
);
