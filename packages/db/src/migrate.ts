import pg from "pg";
import { APP_SCHEMAS, setUpAppRole, type AppRole } from "./database-roles.ts";
import { MigrationError, readMigrations, type Migration } from "./migration-files.ts";

export { MigrationError } from "./migration-files.ts";

// The migrate role's work (self-host-install: Upgrades apply migrations before
// the app starts; design.md, Technical decisions: T4). It runs once before the
// app starts, connected as the database owner:
// - it holds a session advisory lock, so two migrate steps started together
//   apply each migration once: the second waits, then finds nothing to do;
// - it applies the pending migrations in journal order, each in its own
//   transaction together with the row that records it, or, for a migration
//   marked no-transaction, statement by statement outside one;
// - every statement runs under lock_timeout, so a migration that waits for a
//   lock the running app holds fails fast, instead of queueing the app's
//   queries behind it, and says so;
// - then it sets up the app role, whose rights follow the tables the
//   migrations made.
// Migrations only move forward; a problem is fixed by a later migration.
//
// The schema floor (self-host-install: Migrations expand, then contract): the
// runner records the release that ran each migration, and for a contract step
// the expand release it follows. Until a contract step has run, the previous
// release's image runs on the newer schema. An image that lacks a contract
// step the database has run is from before the release that shipped it, so its
// migrate step refuses to start, naming its own release and the release that
// ran the step, and the app does not start. The decision rests on the
// migrations each image carries rather than on comparing version numbers, so
// it also holds for a development build.

export interface DatabaseConnection {
  connectionString: string;
  /** Given apart from the URL, so a secret file can hold it. */
  password?: string;
}

export interface MigrateOptions {
  /** The folder drizzle-kit writes: meta/_journal.json and one .sql file per migration. */
  migrationsFolder: string;
  /** The release of the image that runs the migrations, such as 1.4.0, or 0.0.0-dev for a development build. */
  release: string;
  /** The app role to create or update, with the password from the install's settings. */
  appRole?: AppRole;
  /** How long a migration statement waits for a lock before it fails. */
  lockTimeoutMs?: number;
  /** How long to wait for another migrate step to finish. */
  lockWaitMs?: number;
  log?: (line: string) => void;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_WAIT_MS = 10 * 60_000;

/** The session advisory lock key that every migrate step takes: "tiehall" in ASCII. */
const MIGRATION_LOCK = "32766981562264684";

/** Where the runner records the migrations it applied: a schema the app role has no right on. */
const JOURNAL = "tiehall_migrate.applied_migrations";

/** Postgres's lock_not_available, which a lock_timeout raises. */
const LOCK_NOT_AVAILABLE = "55P03";

export async function migrate(connection: DatabaseConnection, options: MigrateOptions): Promise<void> {
  const lockTimeoutMs = milliseconds(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const lockWaitMs = milliseconds(options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  const log = options.log ?? console.log;
  // A broken image fails here, before it touches the database.
  const migrations = readMigrations(options.migrationsFolder);

  const client = new pg.Client({
    connectionString: withPassword(connection),
    connectionTimeoutMillis: 10_000,
    application_name: "tiehall migrate",
  });
  await client.connect();
  try {
    await takeMigrationLock(client, lockWaitMs, log);
    await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS tiehall_migrate`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL} (
         id text PRIMARY KEY,
         hash text NOT NULL,
         release text NOT NULL,
         contract_after text,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { pending, later } = await pendingMigrations(client, migrations, options.release);
    if (pending.length === 0) {
      log(
        later === 0
          ? "migrate: the schema is up to date"
          : `migrate: the schema is up to date; it also has ${later} migration${later === 1 ? "" : "s"} from a ` +
              "later release, which this release runs on",
      );
    }
    for (const migration of pending) {
      if (migration.transactional) await applyInTransaction(client, migration, lockTimeoutMs, options.release);
      else await applyOutsideTransaction(client, migration, lockTimeoutMs, options.release, log);
      log(`migrate: applied ${migration.id}${migration.transactional ? "" : ", outside a transaction"}`);
    }
    if (options.appRole !== undefined) await setUpAppRole(client, options.appRole);
  } finally {
    // Ending the session releases the advisory lock.
    await client.end();
  }
}

async function takeMigrationLock(client: pg.Client, lockWaitMs: number, log: (line: string) => void): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_LOCK]);
  if (rows[0]?.locked) return;
  log("migrate: waiting for another migrate step to finish");
  await client.query(`SET lock_timeout = '${lockWaitMs}ms'`);
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  } catch (error) {
    if (codeOf(error) !== LOCK_NOT_AVAILABLE) throw error;
    throw new MigrationError(
      `Another migrate step has held the migration lock for more than ${lockWaitMs / 1000} seconds. ` +
        "Let it finish, or stop it, and run migrate again.",
    );
  }
}

interface AppliedMigration {
  id: string;
  hash: string;
  release: string;
  contract_after: string | null;
}

/**
 * The migrations not yet applied, and how many applied ones this image does
 * not have, after checking that none of the applied ones changed and that no
 * contract step this image lacks has run.
 */
async function pendingMigrations(
  client: pg.Client,
  migrations: Migration[],
  release: string,
): Promise<{ pending: Migration[]; later: number }> {
  const { rows } = await client.query<AppliedMigration>(
    `SELECT id, hash, release, contract_after FROM ${JOURNAL} ORDER BY applied_at, id`,
  );
  const known = new Set(migrations.map(({ id }) => id));
  const later = rows.filter(({ id }) => !known.has(id));
  const floor = later.filter(({ contract_after }) => contract_after !== null).at(-1);
  if (floor !== undefined) {
    throw new MigrationError(
      `This image is release ${release}, which is older than this database's schema: its contract step ` +
        `${floor.id} ran with release ${floor.release}, so the schema needs release ${floor.release} or later. ` +
        "To go back past a contract step, restore the backup taken before the upgrade.",
    );
  }
  const applied = new Map(rows.map(({ id, hash }) => [id, hash]));
  const pending: Migration[] = [];
  for (const migration of migrations) {
    const hash = applied.get(migration.id);
    if (hash === undefined) pending.push(migration);
    else if (hash !== migration.hash) {
      throw new MigrationError(
        `Migration ${migration.id} has changed since it was applied to this database. Released migrations ` +
          "never change; fix a problem with a new migration.",
      );
    }
  }
  return { pending, later: later.length };
}

async function applyInTransaction(
  client: pg.Client,
  migration: Migration,
  lockTimeoutMs: number,
  release: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of migration.statements) await client.query(statement);
    await record(client, migration, release);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw failure(migration, error, lockTimeoutMs);
  }
}

/**
 * Runs each statement on its own, as CREATE INDEX CONCURRENTLY needs. Such a
 * build that fails leaves an invalid index behind, which IF NOT EXISTS would
 * then skip; only the migrate step creates indexes, so every invalid index in
 * the app's schemas is one of those, and it is dropped first to be built again.
 */
async function applyOutsideTransaction(
  client: pg.Client,
  migration: Migration,
  lockTimeoutMs: number,
  release: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const invalid = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT i.indisvalid AND n.nspname = ANY($1::text[])
        ORDER BY 1`,
      [APP_SCHEMAS],
    );
    for (const { name } of invalid.rows) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      log(`migrate: dropped the invalid index ${name} that an earlier run left, to build it again`);
    }
    for (const statement of migration.statements) await client.query(statement);
    await record(client, migration, release);
  } catch (error) {
    throw failure(migration, error, lockTimeoutMs);
  }
}

async function record(client: pg.Client, migration: Migration, release: string): Promise<void> {
  await client.query(`INSERT INTO ${JOURNAL} (id, hash, release, contract_after) VALUES ($1, $2, $3, $4)`, [
    migration.id,
    migration.hash,
    release,
    migration.contractAfter ?? null,
  ]);
}

/**
 * The error that names the migration and why it failed. Only Postgres's
 * message goes in, not its detail, which can quote the data a statement met.
 */
function failure(migration: Migration, error: unknown, lockTimeoutMs: number): MigrationError {
  const message = error instanceof Error ? error.message : String(error);
  let reason = `Migration ${migration.id} failed: ${message}.`;
  if (codeOf(error) === LOCK_NOT_AVAILABLE) {
    reason +=
      ` It waited more than ${lockTimeoutMs} ms for a lock that another session holds, such as a long ` +
      `transaction of the running app; ${migration.transactional ? "nothing of it was applied, and " : ""}` +
      "running migrate again retries it.";
  }
  return new MigrationError(reason);
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function milliseconds(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`A timeout must be a positive whole number of ms, not ${value}.`);
  return value;
}

/**
 * The connection string with the password set in it. pg lets the parts of a
 * connection string override its other options, so a separate password option
 * would lose to the URL's (possibly empty) one.
 */
function withPassword({ connectionString, password }: DatabaseConnection): string {
  if (password === undefined) return connectionString;
  const url = new URL(connectionString);
  url.password = encodeURIComponent(password);
  return url.toString();
}
