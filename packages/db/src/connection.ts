import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

// The app's connection to the database (design.md, Technical decisions: T4):
// a pool that web, worker, all and the operator commands open as the app role,
// with the Drizzle schema. Handlers reach it only through withOrg() in
// packages/commands, which opens their transaction.

export interface DatabaseConnection {
  connectionString: string;
  /** Given apart from the URL, so a secret file can hold it. */
  password?: string;
}

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** The transaction a handler runs in. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function openDatabase(connection: DatabaseConnection, options: { applicationName?: string } = {}): Database {
  const pool = new pg.Pool({
    connectionString: withPassword(connection),
    application_name: options.applicationName ?? "tiehall",
  });
  return drizzle({ client: pool, schema });
}

/**
 * The connection string with the password set in it. pg lets the parts of a
 * connection string override its other options, so a separate password option
 * would lose to the URL's (possibly empty) one.
 */
export function withPassword({ connectionString, password }: DatabaseConnection): string {
  if (password === undefined) return connectionString;
  const url = new URL(connectionString);
  url.password = encodeURIComponent(password);
  return url.toString();
}
