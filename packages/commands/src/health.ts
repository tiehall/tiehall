import pg from "pg";
import { withPassword, type DatabaseConnection } from "@tiehall/db";

// The health check behind /healthz (self-host-install: `/healthz` answers only
// up or down; design.md, Self-hosting decisions: S12 and S13). It asks the
// app's database for one row, as the app role, and says "up" when the answer
// comes within the timeout and "down" otherwise; nothing else, such as the
// version or the schema state, is part of the answer. Checks that arrive while
// one runs share its answer, and the check keeps at most one connection, so
// the unauthenticated /healthz cannot be used to open connections.

export type Health = "up" | "down";

export interface DatabaseHealth {
  check(): Promise<Health>;
  close(): Promise<void>;
}

export interface DatabaseHealthOptions {
  /** How long connecting and the query may take before the answer is "down". */
  timeoutMs?: number;
}

/** Well within the 5 seconds the Compose file gives Docker's health check. */
export const HEALTH_TIMEOUT_MS = 2_000;

export function openDatabaseHealth(connection: DatabaseConnection, options: DatabaseHealthOptions = {}): DatabaseHealth {
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: withPassword(connection),
    application_name: "tiehall health",
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    idleTimeoutMillis: 30_000,
  });
  // A connection the database drops while idle is replaced at the next check, which answers "down" until it can be.
  pool.on("error", () => {});
  let running: Promise<Health> | undefined;
  return {
    check() {
      running ??= pool
        .query("SELECT 1")
        .then(
          (): Health => "up",
          (): Health => "down",
        )
        .finally(() => {
          running = undefined;
        });
      return running;
    },
    async close() {
      await pool.end();
    },
  };
}
