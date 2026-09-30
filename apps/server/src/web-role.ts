import process from "node:process";
import { pathToFileURL } from "node:url";
import { createLogger, openDatabase, routeConsoleTo, runningVersion, showRunningVersion, startSetup, startShutdown, type AppSettings, type Logger } from "@tiehall/commands";
import { installRequestGuard } from "./request-guard.ts";
import { TrustedProxies } from "./trusted-proxies.ts";

// The web role (design.md, Technical decisions: T1): the Next.js standalone
// server, loaded into this process behind the request guard, which rewrites
// each request's forwarded headers to the client the install trusts
// (self-host-install: `TIEHALL_URL` and TLS).
//
// The role stops gracefully (self-host-install: A restart stops the app
// gracefully). Next.js is told to leave SIGTERM and SIGINT to it: on either,
// every new call gets 503 with `Retry-After: 0`, the calls in flight get up to
// the drain timeout to finish, and then the role closes its connections and
// exits 0. The role gives the process's shutdown signal first, which ends the
// app's long-poll waits at once with the same 503 (requester-loop: The
// long-poll wait endpoint). Its log lines are JSON on standard output: what
// Next.js prints to the console, such as its version, its addresses and
// "Ready" at start, goes through the role's logger too (self-host-install:
// Logs carry ids, never message text or credentials).
//
// At each start while setup is incomplete, the role prints a new setup code to
// its log and stores its hash, replacing the previous one (self-host-install:
// The setup code guards the setup screen). It does so beside the server's
// start, so a database that cannot be reached never holds the server back: the
// role logs why, serves /healthz, which answers "down", and tries again every
// few seconds until the code is printed.

export interface WebRoleOptions {
  /** The standalone server that `next build` writes, which starts listening when it is loaded. */
  serverModule: string;
  /** How long the calls in flight may take to finish once the role stops. */
  drainTimeoutMs?: number;
  logger?: Logger;
  /** The setup step at start, which prints the setup code while setup is incomplete. */
  setup?: (settings: AppSettings, logger: Logger) => Promise<void>;
}

/** Well within the 30 seconds Compose waits after SIGTERM before it kills the container. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

/** How long the role waits before it tries again to print the setup code, when the database could not be reached. */
export const SETUP_RETRY_MS = 5_000;

/** Prints a new setup code while setup is incomplete, over a connection of its own as the app role. */
export async function printSetupCode(settings: AppSettings, logger: Logger): Promise<void> {
  const database = openDatabase(settings.database, { applicationName: "tiehall web setup code" });
  try {
    await startSetup({ database, url: settings.url, logger });
  } finally {
    await database.$client.end();
  }
}

export async function runWebRole(settings: AppSettings, options: WebRoleOptions): Promise<void> {
  const logger = options.logger ?? createLogger().child({ role: "web" });
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  // Docker sets HOSTNAME to the container id; the server must listen on every interface.
  process.env["HOSTNAME"] = "0.0.0.0";
  process.env["PORT"] = String(settings.port);
  // Next.js installs no handler of its own for SIGTERM and SIGINT; the one below stops the role.
  process.env["NEXT_MANUAL_SIG_HANDLE"] = "true";
  const proxies = new TrustedProxies(settings.trustedProxies);
  await proxies.refresh();
  // The pages the request guard answers itself carry the footer every page carries: the running version and its source.
  showRunningVersion(runningVersion(process.env));
  const guard = installRequestGuard({ proxies });
  routeConsoleTo(logger);

  const setup = options.setup ?? printSetupCode;
  let setupRetry: NodeJS.Timeout | undefined;
  const startSetupStep = async (): Promise<void> => {
    try {
      await setup(settings, logger);
    } catch (error) {
      logger.warn(`web: the setup code could not be printed; trying again in ${SETUP_RETRY_MS / 1000} seconds`, { error });
      setupRetry = setTimeout(() => void startSetupStep(), SETUP_RETRY_MS);
    }
  };
  void startSetupStep();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(setupRetry);
    // The app's long-poll waits end at once with 503 and Retry-After: 0, so the drain does not wait them out.
    startShutdown();
    const inFlight = guard.inFlight;
    logger.info(
      inFlight === 0
        ? "web: stopping; no call is in flight"
        : `web: stopping; new calls get 503 until the ${calls(inFlight)} in flight finish${inFlight === 1 ? "es" : ""}`,
    );
    guard.shutdown(drainTimeoutMs).then(
      ({ cutOff }) => {
        logger.info(cutOff === 0 ? "web: stopped" : `web: stopped; cut off ${calls(cutOff)} still in flight after ${drainTimeoutMs} ms`);
        process.exit(0);
      },
      (error: unknown) => {
        logger.error("web: stop failed", { error });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await import(pathToFileURL(options.serverModule).href);
}

function calls(count: number): string {
  return count === 1 ? "1 call" : `${count} calls`;
}
