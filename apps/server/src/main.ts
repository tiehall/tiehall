// The image's one entrypoint (design.md, Technical decisions: T1): `node main.mjs <role>`.
// It checks the role and the configuration, then starts the role:
// - web imports the Next.js standalone server into this process, behind the
//   request guard, which trusts forwarded headers only from the proxies the
//   settings name;
// - worker and migrate run here: worker works the job queues until SIGTERM,
//   and migrate applies the migrations from /app/packages/db/migrations,
//   beside this bundle, and installs the job queue's schema;
// - all starts web and worker as two child processes, forwards SIGTERM and
//   SIGINT to them, and stops the other when one of them ends;
// - init prints a complete `.env` on standard output, and reads no settings.
// Each role reads its settings from the environment (self-host-install: One
// `.env` holds the install settings): migrate the database owner's and the app
// role's, the others the install URL, the app role's connection and the keys.
// A role whose settings are missing or unusable does not start, and its log
// says why (self-host-install: `TIEHALL_URL` and TLS).
// Exit codes: 2 for an unknown or missing role, 1 for a settings error or
// a failed role, and 0 (or the web server's 143 after SIGTERM) for a clean stop.
// Every role logs JSON lines on standard output (self-host-install: Logs carry
// ids, never message text or credentials), except init, whose standard output
// is the `.env` file; the usage line for a missing or unknown role, printed
// before any role runs, and init's refusals are plain text on standard error.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  readAppSettings,
  readMigrateSettings,
  SettingsError,
  type AppSettings,
  type MigrateSettings,
} from "@tiehall/commands";
import { runInitRole } from "./init-role.ts";
import { migrationsFolderFor, runMigrateRole } from "./migrate-role.ts";
import { parseRole, usage, type Role } from "./roles.ts";
import { runWebRole } from "./web-role.ts";
import { runWorkerRole } from "./worker-role.ts";

/** The image's release, set at build time; a build that names none is a development build. */
const release = process.env["TIEHALL_VERSION"] ?? "0.0.0-dev";
/** This bundle, which `all` runs again for each of its two roles. */
const ENTRY = fileURLToPath(import.meta.url);
/** Where the Next.js standalone server sits in the image: /app/apps/web/server.js beside /app/apps/server/dist/main.mjs. */
const WEB_SERVER = join(dirname(ENTRY), "..", "..", "web", "server.js");

const role = parseRole(process.argv[2]);
if (role === undefined) {
  console.error(usage(process.argv[2]));
  process.exit(2);
}

const logger = createLogger().child({ role });

/** A role with the settings it reads: migrate reads the owner's, and the others the app's. */
type RoleSettings = { role: "migrate"; migrate: MigrateSettings } | { role: Exclude<Role, "migrate" | "init">; app: AppSettings };

if (role === "init") {
  process.exitCode = runInitRole(
    process.argv.slice(3),
    {
      name: process.env["TIEHALL_IMAGE_NAME"] ?? "tiehall",
      version: process.env["TIEHALL_VERSION"] ?? "0.0.0-dev",
      ...(process.env["TIEHALL_COMMIT_SHA"] === undefined ? {} : { commit: process.env["TIEHALL_COMMIT_SHA"] }),
    },
    { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  );
} else {
  await run(readSettings(role));
}

function readSettings(role: Exclude<Role, "init">): RoleSettings {
  try {
    return role === "migrate" ? { role, migrate: readMigrateSettings(process.env) } : { role, app: readAppSettings(process.env) };
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    // A SettingsError names settings and files, never their values.
    logger.error(`tiehall ${role}: ${error.message}`);
    process.exit(1);
  }
}

async function run(settings: RoleSettings): Promise<void> {
  const commit = process.env["TIEHALL_COMMIT_SHA"] ?? "unknown";
  const uid = process.getuid?.() ?? "unknown";
  logger.info(`tiehall ${settings.role}: starting as uid ${uid} (node ${process.version}, commit ${commit})`, {
    uid,
    node: process.version,
    commit,
    release,
  });
  switch (settings.role) {
    case "web":
      return runWebRole(settings.app, { serverModule: WEB_SERVER });
    case "worker":
      return runWorkerRole(settings.app, { logger });
    case "migrate":
      return runMigrate(settings.migrate);
    case "all":
      return superviseAll();
  }
}

async function runMigrate(settings: MigrateSettings): Promise<void> {
  process.exitCode = await runMigrateRole(settings, {
    migrationsFolder: migrationsFolderFor(ENTRY),
    release,
    log: (line) => logger.info(line),
    logError: (line) => logger.error(line),
  });
}

function superviseAll(): void {
  const children = new Map<Role, ChildProcess>();
  let stopping = false;
  let exitCode = 0;

  const stopAll = (signal: NodeJS.Signals) => {
    stopping = true;
    for (const child of children.values()) child.kill(signal);
  };

  for (const child of ["web", "worker"] as const) {
    const subprocess = spawn(process.execPath, [ENTRY, child], { stdio: "inherit" });
    children.set(child, subprocess);
    subprocess.on("exit", (code, signal) => {
      children.delete(child);
      const clean = code === 0 || code === 143 || code === 130;
      if (!stopping) {
        // One half ended on its own: stop the other, so the container restarts as a whole.
        logger.error(`tiehall all: ${child} exited (${signal ?? code}); stopping`);
        exitCode = 1;
        stopAll("SIGTERM");
      } else if (!clean) {
        exitCode = 1;
      }
      if (children.size === 0) process.exit(exitCode);
    });
  }

  process.on("SIGTERM", () => stopAll("SIGTERM"));
  process.on("SIGINT", () => stopAll("SIGINT"));
}
