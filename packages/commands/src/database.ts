import { openDatabase, type Database, type DatabaseConnection } from "@tiehall/db";
import type { Logger } from "./log.ts";

// The app's database handle, which the server opens as the app role and
// execute() hands to withOrg(). Only packages/commands and the migrations may
// import packages/db (design.md, Technical decisions: T2).
export { openDatabase, type Database } from "@tiehall/db";

/**
 * The pool a role keeps open while it runs, as the app role. A connection the
 * database ends while it idles, as a database restart does, is logged, never
 * fatal: the pool drops it and opens a new one for the next query
 * (self-host-install: A restart stops the app gracefully).
 */
export function openAppDatabase(connection: DatabaseConnection, options: { applicationName: string; logger: Logger; role: string }): Database {
  return openDatabase(connection, {
    applicationName: options.applicationName,
    onIdleError: (error) =>
      options.logger.warn(`${options.role}: the database ended an idle connection; the next query opens a new one`, { error }),
  });
}
