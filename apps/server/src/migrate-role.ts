import { dirname, join } from "node:path";
import { migrate } from "@tiehall/commands";
import type { Config } from "./config.ts";

// The migrate role (self-host-install: Upgrades apply migrations before the app
// starts): it runs once before the app starts, connected as the database owner,
// applies the pending migrations and sets up the app role. It exits 0 when it
// is done, and 1 with the reason in its log otherwise, so Compose does not
// start the app on the new image.

/**
 * The migrations folder, found from the entrypoint's own path: the image puts
 * it at /app/packages/db/migrations beside /app/apps/server/dist/main.mjs,
 * where the repository has packages/db/migrations beside apps/server/src/main.ts.
 */
export function migrationsFolderFor(entry: string): string {
  return join(dirname(entry), "..", "..", "..", "packages", "db", "migrations");
}

export interface MigrateRoleOptions {
  migrationsFolder: string;
  /** The image's release, which the migrations record and the schema floor names. */
  release: string;
  lockTimeoutMs?: number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/** Runs the migrate role and returns its exit code. */
export async function runMigrateRole(config: Config, options: MigrateRoleOptions): Promise<number> {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  try {
    // Task 5.1 makes the app role a required setting, and 5.3 gives it to the migrate service.
    await migrate(
      {
        connectionString: config.databaseUrl,
        ...(config.databasePassword === undefined ? {} : { password: config.databasePassword }),
      },
      {
        migrationsFolder: options.migrationsFolder,
        release: options.release,
        ...(config.appRole === undefined ? {} : { appRole: config.appRole }),
        ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
        log: (line) => log(`tiehall ${line}`),
      },
    );
  } catch (error) {
    // The message names the failure (a refused password, a migration and why it failed, an image older than
    // the schema, or an app role with too many rights), never a password.
    logError(`tiehall migrate: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  log("tiehall migrate: done");
  return 0;
}
