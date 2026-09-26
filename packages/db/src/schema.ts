import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  inet,
  integer,
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
// install serves. The web role makes it at the install's first start, before
// anyone has named it, and the setup screen names it. Every other table carries
// `org_id`, first in its primary key, such as (org_id, id), referencing orgs,
// and part of every foreign key to another table; the org id lint checks it.

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The company's name, from the setup screen; none before the setup screen names it. */
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the first admin's sign-in completed setup; until then, pages lead
     * to /setup and API calls answer 503 setup-required (self-host-install:
     * The setup code guards the setup screen).
     */
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
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

// Idempotency keys (public-api: POST operations take an Idempotency-Key;
// design.md, Decisions this change rests on: D28 #20). One row per key a
// caller sent on a POST that succeeded, kept for 24 hours per caller, with a
// digest of the first call's method, path and body and the response it got:
// a repeat with the same body gets that response without running again, and a
// different body gets 422. The row commits with the call's change, so a call
// that fails keeps no key. An hourly job deletes the rows older than 24 hours.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Who sent the key, such as pat:<token id>: keys are kept per caller. */
    caller: text("caller").notNull(),
    /** The Idempotency-Key header's value. */
    key: text("key").notNull(),
    /** A SHA-256 digest of the first call's method, path and body. */
    requestDigest: bytea("request_digest").notNull(),
    /** The first call's status and body, set in the call's transaction once it has its response. */
    status: integer("status"),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.caller, table.key] }),
    index("idempotency_keys_created_at").on(table.orgId, table.createdAt),
    check("idempotency_keys_digest_length", sql`octet_length(${table.requestDigest}) = 32`),
  ],
);

// The setup code (self-host-install: The setup code guards the setup screen;
// design.md, Self-hosting decisions: S3). While setup is incomplete, each start
// of the web role prints a new code to its log and stores only its SHA-256
// here, replacing the previous one. The code carries 140 random bits, so a
// fast hash is enough to keep it out of the database and its backups.
export const setupCodes = pgTable(
  "setup_codes",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id),
    codeHash: bytea("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("setup_codes_hash_length", sql`octet_length(${table.codeHash}) = 32`)],
);

// Setup sessions: a browser that entered the current setup code holds a random
// token in a cookie, and every step of the setup screen needs it. Only the
// token's SHA-256 is stored. They are of no use once setup is complete.
export const setupSessions = pgTable(
  "setup_sessions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    tokenHash: bytea("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("setup_sessions_token_hash").on(table.orgId, table.tokenHash),
    check("setup_sessions_hash_length", sql`octet_length(${table.tokenHash}) = 32`),
  ],
);

// Users (sign-in: One Tiehall user per GitHub account; teams-and-roles: One org
// per install; teams-and-roles: Bot users). One row per person the install
// knows, identified by their GitHub account's numeric id, never by the login
// or an email address; the login is kept to show them by, and follows a
// rename. A user row stays when the person leaves the install, so the
// requests, messages and events that name them keep naming them. Every user is
// an identity of kind human; an admin may flag one as a bot, which is only
// shown.
export const users = pgTable(
  "users",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    /** The GitHub account's numeric id, which never changes. */
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
    /** The GitHub account's login when Tiehall last saw it, which a rename changes. */
    githubLogin: text("github_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Whether an admin flagged the user as a bot, such as a machine account that holds personal access tokens. */
    bot: boolean("bot").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("users_github_account_id").on(table.orgId, table.githubAccountId),
    check("users_github_account_id_positive", sql`${table.githubAccountId} > 0`),
  ],
);

// The members of the install (teams-and-roles: Two roles, admin and member;
// teams-and-roles: Membership is re-checked on every call). A user is a member
// while they have a row here, with exactly one of the two roles. Removing a
// member deletes the row, and their user stays.
export const members = pgTable(
  "members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    foreignKey({
      name: "members_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("members_role_known", sql`${table.role} IN ('admin', 'member')`),
  ],
);

// Blocks that an admin removal records (sign-in: An admin removal blocks
// rejoining through the organization; design.md, Self-hosting decisions: S5).
// When an admin removes a member, their GitHub account is blocked: membership
// of a GitHub organization no longer admits it, and only an invite an admin
// creates after the removal does, whose sign-in clears the block. A removal
// because the person left the GitHub organization records none.
export const signInBlocks = pgTable(
  "sign_in_blocks",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The blocked GitHub account, by its numeric id. */
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.githubAccountId] }),
    foreignKey({
      name: "sign_in_blocks_user_fk",
      columns: [table.orgId, table.githubAccountId],
      foreignColumns: [users.orgId, users.githubAccountId],
    }),
  ],
);

// Teams (teams-and-roles: Teams; teams-and-roles: Team keys). The install's
// teams, kept in Tiehall's own records, each with its current key and a name.
// Only admins change them, through the team operations; nothing is taken from
// GitHub teams or any other outside source. v1 offers no way to delete a team.
// A key has 2 to 10 uppercase letters and digits and starts with a letter.
export const teams = pgTable(
  "teams",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    /** The team's key, such as FE, which its requests' keys and its intake page's URL start with. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("teams_key").on(table.orgId, table.key),
    check("teams_key_format", sql`${table.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check("teams_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 100`),
  ],
);

// The keys teams had before a rename (teams-and-roles: Team keys; design.md,
// Design rules: Teams and roles). When a team's key changes, its old key stays
// an alias of that team and counts as in use by it, so no other team can take
// it; request keys and URLs that use it keep resolving to the team. A key is
// either a team's current key or an alias, never both: a team that takes back
// one of its old keys turns its current key into an alias instead.
export const teamKeyAliases = pgTable(
  "team_key_aliases",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    key: text("key").notNull(),
    teamId: uuid("team_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.key] }),
    foreignKey({
      name: "team_key_aliases_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    index("team_key_aliases_team_id").on(table.orgId, table.teamId),
    check("team_key_aliases_key_format", sql`${table.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
  ],
);

// Who belongs to which team (teams-and-roles: Teams). A member of the install
// can belong to several teams, and a team to nobody. Each row names a
// membership of the install, so removing a member from the install removes
// them from every team with it.
export const teamMembers = pgTable(
  "team_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.teamId, table.userId] }),
    foreignKey({
      name: "team_members_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    foreignKey({
      name: "team_members_member_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [members.orgId, members.userId],
    }).onDelete("cascade"),
    index("team_members_user_id").on(table.orgId, table.userId),
  ],
);

// Used confirmation nonces (agent-safety: One confirmation approves one action;
// design.md, Self-hosting decisions: S7). A review page's nonce is signed, not
// stored, so opening the page changes nothing; once the nonce has approved its
// action, the SHA-256 of its random bytes is recorded here in the action's own
// transaction, so it approves no second one. A record is of no use once its
// nonce has expired, and an hourly job deletes it then.
export const usedConfirmationNonces = pgTable(
  "used_confirmation_nonces",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    nonceHash: bytea("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.nonceHash] }),
    index("used_confirmation_nonces_expires_at").on(table.orgId, table.expiresAt),
    check("used_confirmation_nonces_hash_length", sql`octet_length(${table.nonceHash}) = 32`),
  ],
);

// Requests (requests: A request is addressed to a team of the install;
// requests: Request states; requests: Per-team request keys; design.md,
// Design rules: Requests and events). One row per request: the target team
// it is addressed to and its number in that team's count, which make its key,
// such as FE-142, with the team's current key; its title, which its requester
// wrote; where it is in its lifecycle, as the state machine in packages/core
// keeps it (its state, who holds its claim, and while it waits on blocking
// questions the state it returns to); and its requester, a user and the team
// they picked. A request is never deleted, and its number is never given to
// another request of the team. The users it names stay when they leave the
// install, so a removed member's claim stays theirs.
export const requests = pgTable(
  "requests",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    targetTeamId: uuid("target_team_id").notNull(),
    /** The request's number in its target team's count, from 1. */
    number: integer("number").notNull(),
    /** The title the requester wrote: user text, which agents see fenced. */
    title: text("title").notNull(),
    state: text("state").notNull().default("open"),
    /** The user who holds the claim; none while the request is unclaimed. */
    claimantUserId: uuid("claimant_user_id"),
    /** While the request waits on blocking questions, the state it returns to once they are answered. */
    resumeState: text("resume_state"),
    /** The user who opened the request; none only where the contract-changes capability names a team alone. */
    requestingUserId: uuid("requesting_user_id"),
    requestingTeamId: uuid("requesting_team_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("requests_team_number").on(table.orgId, table.targetTeamId, table.number),
    index("requests_created_at").on(table.orgId, table.createdAt),
    foreignKey({
      name: "requests_target_team_fk",
      columns: [table.orgId, table.targetTeamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    foreignKey({
      name: "requests_requesting_team_fk",
      columns: [table.orgId, table.requestingTeamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    foreignKey({
      name: "requests_requesting_user_fk",
      columns: [table.orgId, table.requestingUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "requests_claimant_fk",
      columns: [table.orgId, table.claimantUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("requests_number_positive", sql`${table.number} > 0`),
    check("requests_title_length", sql`char_length(${table.title}) BETWEEN 1 AND 200`),
    check(
      "requests_state_known",
      sql`${table.state} IN ('open', 'claimed', 'in_progress', 'needs_info', 'done', 'declined', 'withdrawn')`,
    ),
    check("requests_resume_state_known", sql`${table.resumeState} IS NULL OR ${table.resumeState} IN ('open', 'claimed', 'in_progress')`),
    check("requests_needs_info_resumes", sql`${table.state} <> 'needs_info' OR ${table.resumeState} IS NOT NULL`),
    check("requests_resume_state_only_when_waiting", sql`${table.resumeState} IS NULL OR ${table.state} IN ('needs_info', 'done', 'declined', 'withdrawn')`),
    check("requests_open_unclaimed", sql`${table.state} <> 'open' OR ${table.claimantUserId} IS NULL`),
    check("requests_claimed_has_claimant", sql`${table.state} NOT IN ('claimed', 'in_progress') OR ${table.claimantUserId} IS NOT NULL`),
  ],
);

// The count of each team's requests (requests: Per-team request keys; design.md,
// Design rules: Requests and events). One row per team that has had a request,
// holding the last number it gave. The transaction that creates a request takes
// the next number here, which locks the team's row until it ends: concurrent
// creates for one team wait on each other, so no number repeats and a rolled
// back create gives its number back unused, while every other team counts on
// its own. A number a request took is never given again, also once a
// reassignment gives the request a key from another team.
export const requestCounters = pgTable(
  "request_counters",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    teamId: uuid("team_id").notNull(),
    /** The last number given to a request of the team. */
    lastNumber: integer("last_number").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.teamId] }),
    foreignKey({
      name: "request_counters_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    check("request_counters_last_number_positive", sql`${table.lastNumber} > 0`),
  ],
);
