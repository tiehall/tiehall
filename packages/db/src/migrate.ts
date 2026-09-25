import pg from "pg";

export interface DatabaseConnection {
  connectionString: string;
  /** Given apart from the URL, so a secret file can hold it. */
  password?: string;
}

/**
 * The migrate role's work, run once before each roll. Task 3.2 turns this into
 * the migration runner (advisory lock, lock_timeout, non-transactional steps);
 * until there are migrations, it only checks that the database accepts the
 * role's connection, so a broken connection stops the release before the app starts.
 */
export async function migrate(connection: DatabaseConnection): Promise<void> {
  const client = new pg.Client({ connectionString: withPassword(connection), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SELECT 1");
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
