import process from "node:process";
import { pathToFileURL } from "node:url";
import { createLogger, routeConsoleTo, type AppSettings, type Logger } from "@tiehall/commands";
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
// exits 0. Its log lines are JSON on standard output: what Next.js prints to
// the console, such as its version, its addresses and "Ready" at start, goes
// through the role's logger too (self-host-install: Logs carry ids, never
// message text or credentials).

export interface WebRoleOptions {
  /** The standalone server that `next build` writes, which starts listening when it is loaded. */
  serverModule: string;
  /** How long the calls in flight may take to finish once the role stops. */
  drainTimeoutMs?: number;
  logger?: Logger;
}

/** Well within the 30 seconds Compose waits after SIGTERM before it kills the container. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

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
  const guard = installRequestGuard({ proxies });
  routeConsoleTo(logger);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
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
