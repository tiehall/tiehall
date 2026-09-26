import { migrate as migrateDatabase, type DatabaseConnection, type MigrateOptions } from "@tiehall/db";
import { installJobQueue } from "./job-queue.ts";

// The migrate role runs the migrations that live in packages/db. It reaches
// them through here, because only packages/commands and the migrations may
// import packages/db (design.md, Technical decisions: T2). Here it also
// installs the job queue's schema, before the app role is set up, so the app
// role's rights cover the queue's tables (design.md, Technical decisions: T6).
export { type AppRole, type DatabaseConnection, type MigrateOptions } from "@tiehall/db";

export function migrate(connection: DatabaseConnection, options: MigrateOptions): Promise<void> {
  return migrateDatabase(connection, {
    ...options,
    afterMigrations: [...(options.afterMigrations ?? []), installJobQueue],
  });
}
