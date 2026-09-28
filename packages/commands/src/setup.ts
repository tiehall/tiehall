import type { Database } from "@tiehall/db";
import { openAppDatabase } from "./database.ts";
import { createLogger } from "./log.ts";
import { installUrl, readAppDatabase, type Environment } from "./settings.ts";
import { createSetupGate, type SetupGate } from "./setup-gate.ts";

// What the web role's proxy runs before every route (self-host-install: The
// setup code guards the setup screen): the setup gate, built once per process
// from the install's settings, as the app role. It imports nothing of the
// catalog, the sign-in service or the job queue, so the proxy stays small; the
// setup screen itself, which completes setup with the sign-in service, is
// served from @tiehall/commands/web.

let gate: SetupGate | undefined;

/** The setup gate of this process. */
export function setupGate(env: Environment): SetupGate {
  if (gate !== undefined) return gate;
  const logger = createLogger().child({ role: "web" });
  const database: Database = openAppDatabase(readAppDatabase(env), { applicationName: "tiehall web setup gate", logger, role: "web" });
  gate = createSetupGate({ database, url: installUrl(env["TIEHALL_URL"] ?? ""), logger });
  return gate;
}
