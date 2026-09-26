import { openDatabaseHealth, type DatabaseHealth, type Health } from "@tiehall/commands/health";
import { readAppDatabase } from "@tiehall/commands/settings";

// The public health check (self-host-install: `/healthz` answers only up or
// down). It needs no authentication and answers {"status":"up"} while the
// app's database answers, and {"status":"down"} with 503 when it does not, so
// Docker's health check and an operator's monitor see a stopped database. It
// shows nothing else: no version, no schema state and no other detail; the
// admin page shows the running version.

// Asked on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

/** One check for the process, which keeps at most one connection to the database. */
let health: DatabaseHealth | undefined;

export async function GET(): Promise<Response> {
  let status: Health = "down";
  try {
    health ??= openDatabaseHealth(readAppDatabase(process.env));
    status = await health.check();
  } catch {
    // Settings that name no usable database mean the database cannot be reached.
    status = "down";
  }
  return Response.json({ status }, { status: status === "up" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
