import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  json,
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
    /**
     * The nonces of the manifest states whose return from GitHub stored an
     * App (self-host-install: The GitHub App is created with GitHub's manifest
     * flow): each state is used once, and a second return with it is refused.
     */
    usedManifestNonces: text("used_manifest_nonces").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("setup_sessions_token_hash").on(table.orgId, table.tokenHash),
    check("setup_sessions_hash_length", sql`octet_length(${table.tokenHash}) = 32`),
  ],
);

// The install's GitHub App (self-host-install: The GitHub App is created with
// GitHub's manifest flow; design.md, Self-hosting decisions: S4): at most one
// per install, which the setup screen creates through GitHub's manifest flow
// and stores from the code GitHub returns. This row holds what identifies the
// App; its client secret, its private key and, for an App with a webhook, its
// webhook secret are stored integration secrets, encrypted
// (github-app-reachability: design.md, Design rules: An App without a
// webhook). The owner's login and type give the link to the App's settings on
// GitHub.
export const githubApp = pgTable(
  "github_app",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id),
    /** GitHub's numeric id of the App. */
    appId: bigint("app_id", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The App's client id, the issuer of its JSON web tokens and the client of its user authorization. */
    clientId: text("client_id").notNull(),
    /** The login of the account that owns the App. */
    ownerLogin: text("owner_login").notNull(),
    /** Whether the owner is an organization or a personal account, as GitHub names it. */
    ownerType: text("owner_type").notNull(),
    /** When the setup screen stored these credentials, from which the App's webhook deliveries count. */
    storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the redelivery job last read the App's delivery log to the end of
     * what it had to read (tracker-mirrors: Failed GitHub deliveries are
     * redelivered); its next run reads from shortly before then. Null until
     * its first run for this App.
     */
    redeliveryCheckedAt: timestamp("redelivery_checked_at", { withTimezone: true }),
    /**
     * GitHub's mode (tracker-mirrors: GitHub and Jira each run in webhook mode
     * or polling mode): webhook, in which changes arrive as deliveries, or
     * polling, in which Tiehall polls GitHub every 60 seconds.
     */
    mode: text("mode").notNull().default("webhook"),
    /**
     * When the mode was settled: by the check of the App's delivery log after
     * its first installation, or by an admin's switch. Null while the check
     * has yet to run.
     */
    modeSettledAt: timestamp("mode_settled_at", { withTimezone: true }),
    /**
     * When the poll of polling mode last read what changed on GitHub; the next
     * poll reads the changes made since shortly before then. Null until the
     * first poll for this App.
     */
    polledAt: timestamp("polled_at", { withTimezone: true }),
  },
  (table) => [
    check("github_app_owner_type_known", sql`${table.ownerType} IN ('Organization', 'User')`),
    check("github_app_mode_known", sql`${table.mode} IN ('webhook', 'polling')`),
  ],
);

// The deliveries Tiehall asked GitHub to redeliver (tracker-mirrors: Failed
// GitHub deliveries are redelivered; design.md, Self-hosting decisions: S9),
// by the delivery id GitHub keeps on every attempt, with how often it asked.
// Tiehall asks again at each run while the delivery's last attempt failed and
// it is not stored, up to a few times, so a delivery that can never succeed
// does not cost a call every run. Rows older than GitHub's redelivery window
// are deleted by the job.
export const githubRedeliveries = pgTable(
  "github_redeliveries",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** GitHub's X-GitHub-Delivery of the delivery, the same on each of its attempts. */
    deliveryId: text("delivery_id").notNull(),
    /** How many times Tiehall asked GitHub to redeliver it. */
    asks: integer("asks").notNull().default(1),
    lastAskedAt: timestamp("last_asked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.deliveryId] }),
    check("github_redeliveries_delivery_id_format", sql`${table.deliveryId} ~ '^[A-Za-z0-9-]{1,100}$'`),
    check("github_redeliveries_asks_positive", sql`${table.asks} > 0`),
  ],
);

// GitHub's webhook deliveries (tracker-mirrors: GitHub webhooks are verified,
// deduplicated and processed in the background; design.md, Technical
// decisions: T16). One row per delivery whose signature verified, stored once
// by the delivery id GitHub gives it and keeps on a redelivery, with its event
// and payload for the job that processes it. The poll of polling mode stores
// each change it finds here too, in the same form, with a delivery id of its
// own, so both feed the same processing (design.md, Self-hosting decisions:
// S9). A delivery's job is sent in the
// transaction that stores it once setup is complete; a delivery that arrives
// before is held, with no job, until setup completes.
export const githubDeliveries = pgTable(
  "github_deliveries",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** GitHub's X-GitHub-Delivery. */
    deliveryId: text("delivery_id").notNull(),
    /** GitHub's X-GitHub-Event, such as installation or pull_request. */
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** When its processing job was sent; null while it is held until setup completes. */
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /**
     * The change it reports, such as a pull request in a given state, which a
     * delivery and the poll of polling mode name alike (tracker-mirrors:
     * GitHub and Jira each run in webhook mode or polling mode): a change that
     * both see is stored, and so handled, once. Null for a delivery whose
     * change Tiehall does not compare, such as one about an installation.
     */
    changeKey: text("change_key"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.deliveryId] }),
    index("github_deliveries_held").on(table.orgId).where(sql`${table.enqueuedAt} IS NULL`),
    uniqueIndex("github_deliveries_change_key").on(table.orgId, table.changeKey).where(sql`${table.changeKey} IS NOT NULL`),
    check("github_deliveries_delivery_id_format", sql`${table.deliveryId} ~ '^[A-Za-z0-9-]{1,100}$'`),
    check("github_deliveries_event_format", sql`${table.event} ~ '^[a-z_]{1,100}$'`),
    check("github_deliveries_payload_is_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

// The installations of the install's GitHub App, as Tiehall last listed them
// (tracker-mirrors: Admins connect GitHub installations with the confirmation
// step; tracker-mirrors: Covered repositories follow each connected
// installation; github-app-reachability: design.md, Design rules: Finding
// installations, and Technical decisions: T5). Tiehall finds them by listing
// the App's installations through GitHub's API with the App's own
// credentials, never only from a delivery, so an App without a webhook knows
// them too. One row per installation GitHub reported, with the id Tiehall's
// events name it by: its account, which repositories it covers (all, or a
// selection), and whether GitHub reports it suspended. An installation that a
// later listing no longer holds was deleted on GitHub, and is marked so. The
// admin page lists these rows; only the connected ones are acted on.
export const githubInstallations = pgTable(
  "github_installations",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Tiehall's id of the installation, which its events name. */
    id: uuid("id").notNull().defaultRandom(),
    /** GitHub's numeric id of the App the installation belongs to. */
    appId: bigint("app_id", { mode: "number" }).notNull(),
    /** GitHub's numeric id of the installation. */
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    /** The GitHub account the App is installed on, by its numeric id, its login when last listed, and its type. */
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    /** Whether the installation covers all of the account's repositories or a selection of them. */
    repositorySelection: text("repository_selection").notNull(),
    /** When GitHub suspended the installation, as the last listing reported it; null while it is not suspended. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** When a listing first no longer held the installation: it was deleted on GitHub. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    firstListedAt: timestamp("first_listed_at", { withTimezone: true }).notNull().defaultNow(),
    /** When a listing last held the installation. */
    listedAt: timestamp("listed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("github_installations_installation_id").on(table.orgId, table.installationId),
    check("github_installations_ids_positive", sql`${table.appId} > 0 AND ${table.installationId} > 0 AND ${table.accountId} > 0`),
    check("github_installations_account_type_known", sql`${table.accountType} IN ('Organization', 'User')`),
    check("github_installations_repository_selection_known", sql`${table.repositorySelection} IN ('all', 'selected')`),
  ],
);

// The installations an admin connected, or setup connected (tracker-mirrors:
// Admins connect GitHub installations with the confirmation step;
// self-host-install: Setup names the company and makes the first admin).
// Tiehall acts only on these: their repositories count as covered, and
// membership of their GitHub organizations can admit people. Disconnecting
// deletes the row, and the repositories it covered with it.
export const githubConnectedInstallations = pgTable(
  "github_connected_installations",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    installationId: uuid("installation_id").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.installationId] }),
    foreignKey({
      name: "github_connected_installations_installation_fk",
      columns: [table.orgId, table.installationId],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
    }),
  ],
);

// The repositories each connected installation covers, as Tiehall last read
// them through GitHub's API with the installation's own token
// (tracker-mirrors: Covered repositories follow each connected installation;
// github-app-reachability: design.md, Design rules: Finding installations).
// A repository counts as covered while a connected installation that is
// neither suspended nor deleted holds it here.
export const githubCoveredRepositories = pgTable(
  "github_covered_repositories",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    installationId: uuid("installation_id").notNull(),
    /** GitHub's numeric id of the repository, which a rename keeps. */
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    /** The repository's owner and name when last read, such as acme/web. */
    fullName: text("full_name").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.installationId, table.repositoryId] }),
    index("github_covered_repositories_repository_id").on(table.orgId, table.repositoryId),
    foreignKey({
      name: "github_covered_repositories_installation_fk",
      columns: [table.orgId, table.installationId],
      foreignColumns: [githubConnectedInstallations.orgId, githubConnectedInstallations.installationId],
    }).onDelete("cascade"),
    check("github_covered_repositories_repository_id_positive", sql`${table.repositoryId} > 0`),
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
    /** The primary verified email address of the GitHub account, which sign-in reads; email goes nowhere else. */
    email: text("email"),
    /** Whether the user gets the daily digest email; transactional email, such as proposal notices and receipts, ignores it. */
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    /**
     * What the sign-in service knows the user by besides their GitHub
     * account: `github:` and the account's numeric id, never an email
     * address, so the service can never find one person's user by another
     * person's email address (sign-in: One Tiehall user per GitHub account).
     * The service fills it at the user's first sign-in.
     */
    signInKey: text("sign_in_key"),
    /** Whether the last sign-in found a primary verified email address, which `email` then holds. */
    emailVerified: boolean("email_verified").notNull().default(false),
    /** When the sign-in service last changed the user, such as the login or the email address at a sign-in. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The sign-in service's field for a picture of the user, which Tiehall
     * never fills: the web UI loads no image from another host.
     */
    image: text("image"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("users_github_account_id").on(table.orgId, table.githubAccountId),
    uniqueIndex("users_sign_in_key").on(table.signInKey),
    check("users_github_account_id_positive", sql`${table.githubAccountId} > 0`),
    check("users_sign_in_key_format", sql`${table.signInKey} IS NULL OR ${table.signInKey} = 'github:' || ${table.githubAccountId}`),
    check("users_no_image", sql`${table.image} IS NULL`),
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

// Invites (teams-and-roles: Invites by GitHub username; teams-and-roles:
// Revoking an invite; sign-in: Who may sign in). An invite is bound to one
// GitHub account, by the numeric id Tiehall resolved from the username when
// the invite was created, so it follows a login rename and never passes to a
// new holder of the old login; the login it was created for is kept to show
// it by. It names the role the invitee joins with and expires 7 days after it
// was created. The invitee accepts it by signing in with that account while it
// is valid: neither accepted, revoked nor expired.
export const invites = pgTable(
  "invites",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    /** The GitHub account the invite is bound to, by its numeric id. */
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
    /** The GitHub login the invite was created for, as GitHub gave it then. */
    githubLogin: text("github_login").notNull(),
    role: text("role").notNull(),
    /** The admin who created it. */
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When the sign-in that accepted it admitted the invitee, and their user. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
    /** When an admin revoked it, and who. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    foreignKey({ name: "invites_created_by_fk", columns: [table.orgId, table.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ name: "invites_accepted_by_fk", columns: [table.orgId, table.acceptedBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ name: "invites_revoked_by_fk", columns: [table.orgId, table.revokedBy], foreignColumns: [users.orgId, users.id] }),
    index("invites_github_account_id").on(table.orgId, table.githubAccountId),
    check("invites_github_account_id_positive", sql`${table.githubAccountId} > 0`),
    check("invites_role_known", sql`${table.role} IN ('admin', 'member')`),
    check("invites_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
    check("invites_accepted_with_user", sql`(${table.acceptedAt} IS NULL) = (${table.acceptedBy} IS NULL)`),
    check("invites_revoked_by_user", sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`),
    check("invites_accepted_or_revoked", sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`),
  ],
);

// The GitHub organizations Tiehall has seen a member in (sign-in: Who may
// sign in; sign-in: Leaving the GitHub organization ends access). A member
// who joined through membership of a GitHub organization has a row for each
// organization with a connected installation that reported them a member:
// the one that admitted them, and any other a later check found them in. A
// member who joined through an invite, or by completing setup, has none, so
// leaving an organization never removes them. The rows go with the
// membership.
export const memberOrganizations = pgTable(
  "member_organizations",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id").notNull(),
    /** The GitHub organization, by its account's numeric id. */
    githubOrganizationId: bigint("github_organization_id", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId, table.githubOrganizationId] }),
    foreignKey({
      name: "member_organizations_member_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [members.orgId, members.userId],
    }).onDelete("cascade"),
    check("member_organizations_github_organization_id_positive", sql`${table.githubOrganizationId} > 0`),
  ],
);

// Web sessions (sign-in: GitHub is the only way to sign in; sign-in: Signing
// out and ending sessions; design.md, Technical decisions: T7). The sign-in
// service stores one row per browser that signed in with GitHub, found by the
// token its cookie holds. Signing out deletes the row. A removal ends every
// session of the removed person: the row stays, marked ended, so a request
// that still carries its cookie is refused with 403 and no data, and the
// session never works again, even after the person rejoins. The IP address is
// the client address the trusted proxies yield.
export const webSessions = pgTable(
  "web_sessions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    userId: uuid("user_id").notNull(),
    /** The random token the session cookie carries, signed. */
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** When a removal ended the session; it then serves nothing again. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("web_sessions_token").on(table.token),
    index("web_sessions_user_id").on(table.orgId, table.userId),
    foreignKey({
      name: "web_sessions_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
  ],
);

// The GitHub account each user signs in with, as the sign-in service links it
// (sign-in: One Tiehall user per GitHub account; sign-in: Tiehall keeps no
// GitHub user token). One row per user: the provider is always GitHub, and
// the account id is the GitHub account's numeric id, the user's own. The
// token columns are the sign-in service's, and stay empty: Tiehall keeps no
// user token GitHub issued, nor its expiry.
export const signInAccounts = pgTable(
  "sign_in_accounts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    userId: uuid("user_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** The GitHub account's numeric id, as text. */
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("sign_in_accounts_account").on(table.providerId, table.accountId),
    uniqueIndex("sign_in_accounts_user_id").on(table.orgId, table.userId),
    foreignKey({
      name: "sign_in_accounts_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("sign_in_accounts_github_only", sql`${table.providerId} = 'github' AND ${table.accountId} ~ '^[1-9][0-9]{0,18}$'`),
    // Tiehall keeps no password (sign-in: GitHub is the only way to sign in).
    check("sign_in_accounts_no_password", sql`${table.password} IS NULL`),
    check(
      "sign_in_accounts_no_user_token",
      sql`${table.accessToken} IS NULL AND ${table.refreshToken} IS NULL AND ${table.idToken} IS NULL AND ${table.accessTokenExpiresAt} IS NULL AND ${table.refreshTokenExpiresAt} IS NULL`,
    ),
  ],
);

// GitHub accounts refused at sign-in (sign-in: Who may sign in; activity-log:
// Which actions are security events). A refused sign-in creates no session,
// no user and no membership; this record keeps which GitHub account was
// refused, by its numeric id and the login it had then, so the security event
// of the refusal can name it: an event names only Tiehall's own records.
export const signInRefusals = pgTable(
  "sign_in_refusals",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    refusedAt: timestamp("refused_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    check("sign_in_refusals_github_account_id_positive", sql`${table.githubAccountId} > 0`),
  ],
);

// What the sign-in service keeps for a moment, such as the state of a sign-in
// with GitHub between the redirect to GitHub and GitHub's return, which
// expires after 10 minutes.
export const signInVerifications = pgTable(
  "sign_in_verifications",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.id] }), index("sign_in_verifications_identifier").on(table.identifier)],
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
// install, so a removed member's claim stays theirs. For the loop limit
// (agent-safety: Runaway agent loops flag the request needs_human), it also
// keeps whether it waits for a person, and the times of the agent writes on it
// since the last human action, at most 30, which the write that changes it
// updates while it holds the row's lock.
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
    /** Whether agents made so many writes on it since the last human action that it waits for a person. */
    needsHuman: boolean("needs_human").notNull().default(false),
    /** When agents wrote on it since the last human action, oldest first. */
    agentWriteTimes: timestamp("agent_write_times", { withTimezone: true })
      .array()
      .notNull()
      .default(sql`'{}'`),
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
    check("requests_agent_write_times_bounded", sql`cardinality(${table.agentWriteTimes}) <= 30`),
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

// The messages of a request's thread (requests: Thread messages and blocking
// questions; requests: Provenance is stamped by the server; requests: Messages
// are append-only; design.md, Design rules: Requests and events). One row per
// message: the request it belongs to and its place in the thread; its kind, a
// comment, a question, which may be blocking, or an answer, which names the
// question it answers; and its provenance as the server stamped it from the
// caller, never from the payload: the actor kind, never human in v1, the
// accountable human, the client, the surface and the team. Its text lives in
// message_versions, one row per version.
export const messages = pgTable(
  "messages",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    /** The message's place in its request's thread, from 1. */
    number: integer("number").notNull(),
    kind: text("kind").notNull(),
    /** Whether a question blocks the request until it is answered; false for every other kind. */
    blocking: boolean("blocking").notNull().default(false),
    /** For an answer, the question it answers. */
    questionId: uuid("question_id"),
    actorKind: text("actor_kind").notNull(),
    /** The accountable human, by their Tiehall user id. */
    actorUserId: uuid("actor_user_id"),
    /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
    client: text("client"),
    surface: text("surface"),
    /** The team the user acted for. */
    teamId: uuid("team_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * For an agent's blocking question that moved its request from in_progress
     * to needs_info, the UTC day of the flip it started, which the flip limit
     * counts (agent-safety: A request flips between needs_info and in_progress
     * at most 3 times a day).
     */
    countedFlipOn: date("counted_flip_on"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("messages_request_number").on(table.orgId, table.requestId, table.number),
    index("messages_question_id").on(table.orgId, table.questionId),
    foreignKey({
      name: "messages_request_fk",
      columns: [table.orgId, table.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }),
    foreignKey({
      name: "messages_question_fk",
      columns: [table.orgId, table.questionId],
      foreignColumns: [table.orgId, table.id],
    }),
    foreignKey({
      name: "messages_actor_user_fk",
      columns: [table.orgId, table.actorUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "messages_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    check("messages_number_positive", sql`${table.number} > 0`),
    check("messages_kind_known", sql`${table.kind} IN ('comment', 'question', 'answer')`),
    check("messages_blocking_questions_only", sql`NOT ${table.blocking} OR ${table.kind} = 'question'`),
    check("messages_flips_blocking_questions_only", sql`${table.countedFlipOn} IS NULL OR ${table.blocking}`),
    check("messages_answers_name_questions", sql`(${table.kind} = 'answer') = (${table.questionId} IS NOT NULL)`),
    check("messages_actor_kind_known", sql`${table.actorKind} IN ('agent', 'web_session', 'system', 'integration')`),
    check(
      "messages_surface_known",
      sql`${table.surface} IS NULL OR ${table.surface} IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')`,
    ),
    check(
      "messages_actor_names_user",
      sql`${table.actorKind} NOT IN ('agent', 'web_session') OR (${table.actorUserId} IS NOT NULL AND ${table.surface} IS NOT NULL)`,
    ),
  ],
);

// The versions of each message's text (requests: Messages are append-only;
// design.md, Design rules: Requests and events). A message is posted with
// version 1, and an edit adds the next version and never changes an earlier
// one, so every version reads back exactly as it was written.
export const messageVersions = pgTable(
  "message_versions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    messageId: uuid("message_id").notNull(),
    /** The version's number, from 1. */
    version: integer("version").notNull(),
    /** The text of this version, as its author wrote it: user text, which agents see fenced. */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.messageId, table.version] }),
    foreignKey({
      name: "message_versions_message_fk",
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
    }),
    check("message_versions_version_positive", sql`${table.version} > 0`),
    check("message_versions_body_length", sql`char_length(${table.body}) BETWEEN 1 AND 65536`),
  ],
);

// The revisions of each request's packet (handoff-packet: Immutable, numbered
// revisions; handoff-packet: Open objects, strict server; design.md, Design
// rules: Handoff packet). One row per revision: the request, its number, from
// 1 for the packet the request was opened with, and the packet as Tiehall
// parsed it, with only the keys the packet schema knows, and extensions as
// sent. The packet is kept as json, not jsonb, so it reads back with its keys
// in the order they were stored. Its provenance is the server's stamp from the
// caller, as for a message.
export const packetRevisions = pgTable(
  "packet_revisions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    /** The revision's number, from 1. */
    number: integer("number").notNull(),
    /** The packet: user text under its `untrusted` object, which agents see fenced. */
    packet: json("packet").notNull(),
    actorKind: text("actor_kind").notNull(),
    /** The accountable human, by their Tiehall user id. */
    actorUserId: uuid("actor_user_id"),
    /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
    client: text("client"),
    surface: text("surface"),
    /** The team the user acted for. */
    teamId: uuid("team_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    uniqueIndex("packet_revisions_request_number").on(table.orgId, table.requestId, table.number),
    foreignKey({
      name: "packet_revisions_request_fk",
      columns: [table.orgId, table.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }),
    foreignKey({
      name: "packet_revisions_actor_user_fk",
      columns: [table.orgId, table.actorUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "packet_revisions_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    check("packet_revisions_number_positive", sql`${table.number} > 0`),
    check("packet_revisions_packet_is_object", sql`json_typeof(${table.packet}) = 'object'`),
    check("packet_revisions_actor_kind_known", sql`${table.actorKind} IN ('agent', 'web_session', 'system', 'integration')`),
    check(
      "packet_revisions_surface_known",
      sql`${table.surface} IS NULL OR ${table.surface} IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')`,
    ),
    check(
      "packet_revisions_actor_names_user",
      sql`${table.actorKind} NOT IN ('agent', 'web_session') OR (${table.actorUserId} IS NOT NULL AND ${table.surface} IS NOT NULL)`,
    ),
  ],
);

// Read cursors (requests: Read cursors move only on acknowledgement; design.md,
// Design rules: Requests and events). One row per user and reader, where a
// reader is one client of theirs: an OAuth client, such as the CLI or an MCP
// client, a personal access token, or the web UI. It holds the number of the
// last event the reader acknowledged; reading moves nothing, and only the
// reader's own acknowledgement moves it, never back.
export const readCursors = pgTable(
  "read_cursors",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id").notNull(),
    /** Which of the user's clients reads, such as oauth:<client id>, pat:<token id> or web. */
    reader: text("reader").notNull(),
    /** The number of the last event the reader acknowledged; 0 before the first. */
    acknowledged: bigint("acknowledged", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId, table.reader] }),
    foreignKey({
      name: "read_cursors_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("read_cursors_acknowledged_not_negative", sql`${table.acknowledged} >= 0`),
    check("read_cursors_reader_length", sql`char_length(${table.reader}) BETWEEN 1 AND 2048`),
  ],
);

// The writes of each agent token in the last minute (agent-safety: Agent
// writes are limited per token and budgeted per install; design.md, Technical
// decisions: T14). One row per write made with an OAuth grant or a personal
// access token, by the token's key, such as pat:<id> or oauth:<client>:<user>,
// and its time; the write that counts one first takes a transaction lock on
// the token, so two writes at once count one after the other. Rows older than
// a minute say nothing and are deleted by the token's next write.
export const agentTokenWrites = pgTable(
  "agent_token_writes",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    /** Which token wrote: pat:<token id> or oauth:<client id>:<user id>. */
    token: text("token").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("agent_token_writes_token_time").on(table.orgId, table.token, table.writtenAt),
    check("agent_token_writes_token_length", sql`char_length(${table.token}) BETWEEN 1 AND 2200`),
  ],
);

// The install's agent writes per UTC day (agent-safety: Agent writes are
// limited per token and budgeted per install). One row per day on which agents
// wrote, which each agent write updates in its transaction, holding the row's
// lock, and only while the day's writes are under the budget.
export const agentWriteDays = pgTable(
  "agent_write_days",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The UTC day. */
    day: date("day").notNull(),
    writes: integer("writes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.day] }), check("agent_write_days_writes_not_negative", sql`${table.writes} >= 0`)],
);

// The install's settings that an admin changes in the web UI with the
// confirmation step (design.md, Self-hosting decisions: S2 and S7). One row
// for the install's org, made by the first change; until then every setting
// has its default. The daily write budget is 5,000 agent writes by default
// (agent-safety: Agent writes are limited per token and budgeted per install),
// and the sign-in policy admits organization members and invited people.
export const installSettings = pgTable(
  "install_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id),
    dailyWriteBudget: integer("daily_write_budget").notNull().default(5000),
    /**
     * The sign-in policy (sign-in: The sign-in policy): whether membership of a
     * GitHub organization admits new members, or only invites do.
     */
    signInPolicy: text("sign_in_policy").notNull().default("organization_members_and_invited"),
  },
  (table) => [
    check("install_settings_daily_write_budget_range", sql`${table.dailyWriteBudget} BETWEEN 1 AND 1000000`),
    check("install_settings_sign_in_policy_known", sql`${table.signInPolicy} IN ('organization_members_and_invited', 'invited_only')`),
  ],
);

// The requests agents opened (agent-safety: Agent-opened requests are capped).
// One row per request opened with an OAuth token or a personal access token:
// who it was opened for, from which team to which, and when, by the clock of
// the call that opened it. The caps on opened requests count these rows.
export const agentOpenedRequests = pgTable(
  "agent_opened_requests",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    requestId: uuid("request_id").notNull(),
    userId: uuid("user_id").notNull(),
    requestingTeamId: uuid("requesting_team_id").notNull(),
    targetTeamId: uuid("target_team_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.requestId] }),
    index("agent_opened_requests_user_time").on(table.orgId, table.userId, table.openedAt),
    index("agent_opened_requests_pair_time").on(table.orgId, table.requestingTeamId, table.targetTeamId, table.openedAt),
    foreignKey({
      name: "agent_opened_requests_request_fk",
      columns: [table.orgId, table.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }),
    foreignKey({
      name: "agent_opened_requests_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "agent_opened_requests_requesting_team_fk",
      columns: [table.orgId, table.requestingTeamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    foreignKey({
      name: "agent_opened_requests_target_team_fk",
      columns: [table.orgId, table.targetTeamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
  ],
);

// Proposals (requests: Commitments become proposals; requests: Cross-team
// commitments need a confirmation from each side; requests: What a proposal
// records and shows; handoff-packet: Packet changes that are commitments;
// design.md, Design rules: Requests and events). A commitment started for a
// user becomes a proposal instead of taking effect: one row per proposal, with
// its request, the kind of commitment, the rules its second confirmation must
// meet (none when its accountable human's confirmation is enough), its
// accountable human and the side of the request they were on when they
// proposed it, who proposed it as the server stamped it, what it changes (for a
// packet change, the proposed packet, and the revision it was based on), where
// it is (pending until it takes effect or ends), when it was created and when
// it expires, 7 days later. What it proposes never changes once it is stored:
// a different commitment is a new proposal.
export const proposals = pgTable(
  "proposals",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    kind: text("kind").notNull(),
    /** The rules the second confirmation must all meet: target_team, requester_side or claimant; none for one confirmation. */
    secondConfirmation: text("second_confirmation").array().notNull().default(sql`'{}'`),
    /** The user who proposed it, whose confirmation it needs first. */
    accountableUserId: uuid("accountable_user_id").notNull(),
    /** The side of the request the accountable human was on when they proposed it. */
    accountableSide: text("accountable_side").notNull(),
    actorKind: text("actor_kind").notNull(),
    /** The client: its Client ID Metadata Document URL, the OAuth client, or the CLI version. */
    client: text("client"),
    surface: text("surface"),
    /** The team the user acted for. */
    teamId: uuid("team_id"),
    /** What it changes: for a packet change, { packet }; for a reassignment, { teamId }; otherwise {}. */
    change: json("change").notNull(),
    /** For a packet change, the revision it was based on. */
    baseRevision: integer("base_revision"),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When it took effect or ended without taking effect; none while it is pending. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Why it was cancelled: its request reached a terminal state, was reassigned, lost its accountable human, or moved past its base revision. */
    cancelReason: text("cancel_reason"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("proposals_request_id").on(table.orgId, table.requestId),
    foreignKey({
      name: "proposals_request_fk",
      columns: [table.orgId, table.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }),
    foreignKey({
      name: "proposals_accountable_user_fk",
      columns: [table.orgId, table.accountableUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "proposals_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    check("proposals_kind_known", sql`${table.kind} IN ('due_date', 'scope', 'decline', 'reassign', 'withdraw', 'done')`),
    check(
      "proposals_second_confirmation_known",
      sql`${table.secondConfirmation} <@ ARRAY['target_team', 'requester_side', 'claimant']::text[]`,
    ),
    check("proposals_accountable_side_known", sql`${table.accountableSide} IN ('requester_side', 'target_team')`),
    check("proposals_actor_kind_known", sql`${table.actorKind} IN ('agent', 'web_session', 'integration')`),
    check(
      "proposals_surface_known",
      sql`${table.surface} IS NULL OR ${table.surface} IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')`,
    ),
    check("proposals_change_is_object", sql`json_typeof(${table.change}) = 'object'`),
    check("proposals_packet_changes_have_a_base", sql`(${table.kind} IN ('due_date', 'scope')) = (${table.baseRevision} IS NOT NULL)`),
    check(
      "proposals_state_known",
      sql`${table.state} IN ('pending', 'applied', 'rejected', 'withdrawn', 'expired', 'cancelled')`,
    ),
    check("proposals_expire_after_7_days", sql`${table.expiresAt} = ${table.createdAt} + interval '7 days'`),
    check("proposals_ended_when_not_pending", sql`(${table.state} = 'pending') = (${table.endedAt} IS NULL)`),
    check(
      "proposals_cancel_reason_known",
      sql`(${table.state} = 'cancelled') = (${table.cancelReason} IS NOT NULL) AND (${table.cancelReason} IS NULL OR ${table.cancelReason} IN ('terminal_state', 'reassigned', 'accountable_removed', 'stale'))`,
    ),
  ],
);

// The confirmations proposals have received (requests: What a proposal records
// and shows; requests: Cross-team commitments need a confirmation from each
// side). One row per confirmation: the proposal, its step (the accountable
// human's, or the other side's), the user who gave it in the web UI and when.
// A confirmation never changes once it is given, which the database also
// refuses, so it stays valid while the proposal waits for the other side.
export const proposalConfirmations = pgTable(
  "proposal_confirmations",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    proposalId: uuid("proposal_id").notNull(),
    step: text("step").notNull(),
    userId: uuid("user_id").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.proposalId, table.step] }),
    foreignKey({
      name: "proposal_confirmations_proposal_fk",
      columns: [table.orgId, table.proposalId],
      foreignColumns: [proposals.orgId, proposals.id],
    }),
    foreignKey({
      name: "proposal_confirmations_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("proposal_confirmations_step_known", sql`${table.step} IN ('accountable_human', 'other_side')`),
  ],
);

// The keys a request had before a reassignment (requests: Reassignment gives a
// new key and the old key redirects). A confirmed reassignment gives the
// request the next number of its new team; its old team and number stay here,
// naming the request, so its old key keeps resolving to it under its current
// key. A number is never given to another request of its team.
export const requestFormerKeys = pgTable(
  "request_former_keys",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    teamId: uuid("team_id").notNull(),
    number: integer("number").notNull(),
    requestId: uuid("request_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.teamId, table.number] }),
    foreignKey({
      name: "request_former_keys_team_fk",
      columns: [table.orgId, table.teamId],
      foreignColumns: [teams.orgId, teams.id],
    }),
    foreignKey({
      name: "request_former_keys_request_fk",
      columns: [table.orgId, table.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }),
    check("request_former_keys_number_positive", sql`${table.number} > 0`),
  ],
);

// The proposal notices sent by email (requests: Where a proposal waits;
// design.md, Self-hosting decisions: S10). One row per proposal and person who
// got the email that it waits for their confirmation, so each person gets it
// once, when the proposal starts to wait for them, and a person who becomes
// able to give a waiting confirmation gets theirs then.
export const proposalNotices = pgTable(
  "proposal_notices",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    proposalId: uuid("proposal_id").notNull(),
    userId: uuid("user_id").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.proposalId, table.userId] }),
    foreignKey({
      name: "proposal_notices_proposal_fk",
      columns: [table.orgId, table.proposalId],
      foreignColumns: [proposals.orgId, proposals.id],
    }),
    foreignKey({
      name: "proposal_notices_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
  ],
);

// Receipts (requests: Receipts; requester-loop: The web inbox). One row per
// receipt a person gets for a confirmation: that they confirmed a commitment
// that now waits for the other side, or that it took effect with their
// confirmation. Its words come from the proposal as it is when it is read, so a
// receipt that says a proposal waits shows how it ended once it ends. It is
// listed in the standing list of the person's web inbox and, with SMTP set,
// emailed once.
export const receipts = pgTable(
  "receipts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    id: uuid("id").notNull().defaultRandom(),
    userId: uuid("user_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** When it was emailed; none until it is, and never without SMTP. */
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("receipts_user_id").on(table.orgId, table.userId, table.createdAt),
    foreignKey({
      name: "receipts_user_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [users.orgId, users.id],
    }),
    foreignKey({
      name: "receipts_proposal_fk",
      columns: [table.orgId, table.proposalId],
      foreignColumns: [proposals.orgId, proposals.id],
    }),
    check("receipts_kind_known", sql`${table.kind} IN ('waits_for_other_side', 'took_effect', 'undone')`),
  ],
);

// The commitments that took effect and can be undone (requests: The undo
// window for reversible commitments). One row per proposal whose due date,
// scope change, reassignment or decline took effect: when, what the request
// had before (its state, claim and blocking questions' return state, and for a
// reassignment its team and number), for a packet change the revision it
// created, and, once it is undone, when and by whom.
export const appliedCommitments = pgTable(
  "applied_commitments",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    proposalId: uuid("proposal_id").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
    /** What the request had before the commitment, which an undo restores. */
    before: json("before").notNull(),
    /** For a due date or a scope change, the revision it added. */
    createdRevision: integer("created_revision"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneByUserId: uuid("undone_by_user_id"),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.proposalId] }),
    foreignKey({
      name: "applied_commitments_proposal_fk",
      columns: [table.orgId, table.proposalId],
      foreignColumns: [proposals.orgId, proposals.id],
    }),
    foreignKey({
      name: "applied_commitments_undone_by_fk",
      columns: [table.orgId, table.undoneByUserId],
      foreignColumns: [users.orgId, users.id],
    }),
    check("applied_commitments_before_is_object", sql`json_typeof(${table.before}) = 'object'`),
    check("applied_commitments_undone_by_someone", sql`(${table.undoneAt} IS NULL) = (${table.undoneByUserId} IS NULL)`),
  ],
);
