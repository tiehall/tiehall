import pg from "pg";
import { setUpAppRole, type AppRole } from "./database-roles.ts";

export interface DatabaseConnection {
  connectionString: string;
  /** Given apart from the URL, so a secret file can hold it. */
  password?: string;
}

export interface MigrateOptions {
  /** The app role to create or update, with the password from the install's settings. */
  appRole?: AppRole;
}

/**
 * The migrate role's work, run once before the app starts. It connects as the
 * database owner, so a broken connection stops the release before the app
 * starts, and sets up the app role that the app connects as. Task 4.2 adds the
 * migration runner (advisory lock, lock_timeout, non-transactional steps).
 */
export async function migrate(connection: DatabaseConnection, options: MigrateOptions = {}): Promise<void> {
  const client = new pg.Client({ connectionString: withPassword(connection), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SELECT 1");
    if (options.appRole !== undefined) await setUpAppRole(client, options.appRole);
  } finally {
    await client.end();
  }
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
