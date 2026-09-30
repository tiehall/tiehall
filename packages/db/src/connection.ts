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

export interface OpenDatabaseOptions {
  /** The name the connections show in pg_stat_activity. */
  applicationName?: string;
  /**
   * Hears of a connection the database ended while it sat idle in the pool,
   * such as on a database restart. The pool has dropped it already and opens a
   * new one for the next query, so the caller only logs it.
   */
  onIdleError?: (error: Error) => void;
}

export function openDatabase(connection: DatabaseConnection, options: OpenDatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString: withPassword(connection),
    application_name: options.applicationName ?? "tiehall",
  });
  // An error event that nothing listens to would crash the process, and a database restart ends every idle connection.
  pool.on("error", (error) => options.onIdleError?.(error));
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

/** A connection that listens on one channel for Postgres notifications (NOTIFY). */
export interface Listener {
  close(): Promise<void>;
}

export interface ListenOptions {
  /** The name the connection shows in pg_stat_activity. */
  applicationName?: string;
  /** Hears each notification on the channel, with its payload. */
  onNotification(payload: string | undefined): void;
  /** Hears that the connection failed or ended without close(); it listens no more. */
  onLost(error: Error): void;
}

/**
 * Opens a connection of its own, outside the pool, and listens on the channel
 * (LISTEN); resolves once it listens, so a notification sent after that is
 * heard.
 */
export async function listen(connection: DatabaseConnection, channel: string, options: ListenOptions): Promise<Listener> {
  const client = new pg.Client({ connectionString: withPassword(connection), application_name: options.applicationName ?? "tiehall listener" });
  let closing = false;
  let lost = false;
  const lose = (error: Error) => {
    if (closing || lost) return;
    lost = true;
    options.onLost(error);
  };
  client.on("notification", (message) => {
    if (message.channel === channel) options.onNotification(message.payload);
  });
  client.on("error", lose);
  client.on("end", () => lose(new Error("The listening connection ended.")));
  try {
    await client.connect();
    await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
  } catch (error) {
    closing = true;
    await client.end().catch(() => {});
    throw error;
  }
  return {
    async close() {
      closing = true;
      await client.end().catch(() => {});
    },
  };
}
