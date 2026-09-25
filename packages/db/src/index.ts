// @tiehall/db: the schema, the migrations and the database roles. Only
// packages/commands and the migrations import it (design.md, Technical decisions: T2).
export { migrate, type DatabaseConnection, type MigrateOptions } from "./migrate.ts";
export { type AppRole } from "./database-roles.ts";
