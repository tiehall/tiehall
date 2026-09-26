// @tiehall/db: the schema, the migrations and their runner, the database roles
// and the app's connection. Only packages/commands and the migrations import it
// (design.md, Technical decisions: T2).
export {
  openDatabase,
  withPassword,
  type Database,
  type DatabaseConnection,
  type OpenDatabaseOptions,
  type Transaction,
} from "./connection.ts";
export { JOB_QUEUE_SCHEMA, type AppRole } from "./database-roles.ts";
export { migrate, MigrationError, type MigrateOptions } from "./migrate.ts";
export * from "./schema.ts";
