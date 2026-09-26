// The image's one entrypoint (design.md, Technical decisions: T1): `node main.mjs <role>`.
// It checks the role and the configuration, then starts the role:
// - web imports the Next.js standalone server into this process;
// - worker and migrate run here: worker works the job queues until SIGTERM,
//   and migrate applies the migrations from /app/packages/db/migrations,
//   beside this bundle, and installs the job queue's schema;
// - all starts web and worker as two child processes, forwards SIGTERM and
//   SIGINT to them, and stops the other when one of them ends.
// Exit codes: 2 for an unknown or missing role, 1 for a configuration error or
// a failed role, and 0 (or the web server's 143 after SIGTERM) for a clean stop.
// Every role logs JSON lines on standard output (self-host-install: Logs carry
// ids, never message text or credentials); only the usage line for a missing
// or unknown role, printed before any role runs, is plain text on standard
// error.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "@tiehall/commands";
import { ConfigError, readConfig, type Config } from "./config.ts";
import { migrationsFolderFor, runMigrateRole } from "./migrate-role.ts";
import { parseRole, usage, type Role } from "./roles.ts";
import { runWorkerRole } from "./worker-role.ts";

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

let config: Config;
try {
  config = readConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // A ConfigError names settings and files, never their values.
  logger.error(`tiehall ${role}: ${error.message}`);
  process.exit(1);
}

const commit = process.env["TIEHALL_COMMIT_SHA"] ?? "unknown";
/** The image's release, set at build time; a build that names none is a development build. */
const release = process.env["TIEHALL_VERSION"] ?? "0.0.0-dev";
const uid = process.getuid?.() ?? "unknown";
logger.info(`tiehall ${role}: starting as uid ${uid} (node ${process.version}, commit ${commit})`, {
  uid,
  node: process.version,
  commit,
  release,
});

await run(role, config);

async function run(role: Role, config: Config): Promise<void> {
  switch (role) {
    case "web":
      return startWeb(config);
    case "worker":
      return runWorkerRole(config, { logger });
    case "migrate":
      return runMigrate(config);
    case "all":
      return superviseAll();
  }
}

async function startWeb(config: Config): Promise<void> {
  // Docker sets HOSTNAME to the container id; the server must listen on every interface.
  process.env["HOSTNAME"] = "0.0.0.0";
  process.env["PORT"] = String(config.port);
  // The Next.js server handles SIGTERM itself: it finishes in-flight requests, then exits.
  await import(pathToFileURL(WEB_SERVER).href);
}

async function runMigrate(config: Config): Promise<void> {
  process.exitCode = await runMigrateRole(config, {
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
