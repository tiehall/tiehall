import type { Database } from "@tiehall/db";
import { openAppDatabase } from "./database.ts";
import { createLogger, type Logger } from "./log.ts";
import { openSecretBox, type SecretBox } from "./secret-box.ts";
import { installUrl, readAppDatabase, readSecretKey, type Environment } from "./settings.ts";
import { createSetupGate, type SetupGate } from "./setup-gate.ts";
import { createSetupRoute, type SetupRoute } from "./setup-route.ts";

// What the web role runs for setup (self-host-install: The setup code guards
// the setup screen; self-host-install: The GitHub App is created with GitHub's
// manifest flow): the setup gate, which its proxy runs before any route, and
// the setup screen at /setup, with its steps under it. Both are built once per
// process from the install's settings and share one pool, as the app role.
// They import nothing of the catalog or the job queue, so the proxy stays
// small. The setup screen reads TIEHALL_SECRET_KEY, which encrypts the GitHub
// App's credentials, only when it stores them.

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
  let box: SecretBox | undefined;
  route ??= createSetupRoute({ ...setupServices(env), secrets: () => (box ??= openSecretBox(readSecretKey(env))) });
  return route;
}
