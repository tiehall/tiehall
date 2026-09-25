// The image's one entrypoint (design.md decision 1): `node main.mjs <role>`.
// It checks the role and the configuration, then starts the role:
// - web imports the Next.js standalone server into this process;
// - worker and migrate run here;
// - all starts web and worker as two child processes, forwards SIGTERM and
//   SIGINT to them, and stops the other when one of them ends.
// Exit codes: 2 for an unknown or missing role, 1 for a configuration error or
// a failed role, and 0 (or the web server's 143 after SIGTERM) for a clean stop.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate, startWorker } from "@tiehall/commands";
import { ConfigError, readConfig, type Config } from "./config.ts";
import { parseRole, usage, type Role } from "./roles.ts";

/** This bundle, which `all` runs again for each of its two roles. */
const ENTRY = fileURLToPath(import.meta.url);
/** Where the Next.js standalone server sits in the image: /app/apps/web/server.js beside /app/apps/server/dist/main.mjs. */
const WEB_SERVER = join(dirname(ENTRY), "..", "..", "web", "server.js");

const role = parseRole(process.argv[2]);
if (role === undefined) {
  console.error(usage(process.argv[2]));
  process.exit(2);
}

let config: Config;
try {
  config = readConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`tiehall ${role}: ${error.message}`);
  process.exit(1);
}

const commit = process.env["TIEHALL_COMMIT_SHA"] ?? "unknown";
console.log(`tiehall ${role}: starting as uid ${process.getuid?.() ?? "unknown"} (node ${process.version}, commit ${commit})`);

await run(role, config);

async function run(role: Role, config: Config): Promise<void> {
  switch (role) {
    case "web":
      return startWeb(config);
    case "worker":
      return runWorker();
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

function runWorker(): void {
  const worker = startWorker();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("tiehall worker: stop failed", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function runMigrate(config: Config): Promise<void> {
  try {
    await migrate({
      connectionString: config.databaseUrl,
      ...(config.databasePassword === undefined ? {} : { password: config.databasePassword }),
    });
  } catch (error) {
    // The driver's message names the failure (for example a refused password), never the password.
    console.error(`tiehall migrate: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log("tiehall migrate: done");
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
        console.error(`tiehall all: ${child} exited (${signal ?? code}); stopping`);
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
