import type { Database } from "@tiehall/db";
import { openAppDatabase } from "./database.ts";
import { createLogger, type Logger } from "./log.ts";
import { installUrl, readAppDatabase, type Environment } from "./settings.ts";
import { createSetupGate, type SetupGate } from "./setup-gate.ts";
import { createSetupRoute, type SetupRoute } from "./setup-route.ts";

// What the web role runs for setup (self-host-install: The setup code guards
// the setup screen): the setup gate, which its proxy runs before any route, and
// the setup screen at /setup. Both are built once per process from the
// install's settings and share one pool, as the app role. They import nothing
// of the catalog or the job queue, so the proxy stays small.

let shared: { database: Database; url: string; logger: Logger } | undefined;
let gate: SetupGate | undefined;
let route: SetupRoute | undefined;

function setupServices(env: Environment): { database: Database; url: string; logger: Logger } {
  if (shared !== undefined) return shared;
  const logger = createLogger().child({ role: "web" });
  const database = openAppDatabase(readAppDatabase(env), { applicationName: "tiehall web setup", logger, role: "web" });
  shared = { database, url: installUrl(env["TIEHALL_URL"] ?? ""), logger };
  return shared;
}

/** The setup gate of this process. */
export function setupGate(env: Environment): SetupGate {
  gate ??= createSetupGate(setupServices(env));
  return gate;
}

/** The setup screen of this process. */
export function setupRoute(env: Environment): SetupRoute {
  route ??= createSetupRoute(setupServices(env));
  return route;
}
