// @tiehall/db: the schema, the migrations and their runner, the database roles
// and the app's connection. Only packages/commands and the migrations import it
// (design.md, Technical decisions: T2).
export { openDatabase, type Database, type DatabaseConnection, type Transaction } from "./connection.ts";
export { type AppRole } from "./database-roles.ts";
export { migrate, type MigrateOptions } from "./migrate.ts";
export * from "./schema.ts";
