// Starts the web app's standalone server as the web role does, for web-app.ts:
// every server it creates gives each answer of a request URL or an intake page
// the headers every such answer carries, Vary: Accept, Authorization,
// Cache-Control: private, no-store and an ETag (negotiation.ts), as the web
// role's request guard does, and the rest of the guard is left out. Its one
// argument is the standalone server's path. It stops as the web role does
// (self-host-install: A restart stops the app gracefully): on SIGTERM it gives
// the process's shutdown signal, which ends the long-poll waits at once with
// 503 and Retry-After: 0, lets those answers go out, and exits; Next.js is
// told to leave the signal to it.
import http, { type RequestListener } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { negotiatedUrlHeaders } from "../../src/negotiation.ts";
import { startShutdown } from "../../src/shutdown.ts";

/** How long the answers the shutdown ends get to go out before the process exits. */
const DRAIN_MS = 300;

process.env["NEXT_MANUAL_SIG_HANDLE"] = "true";
const stop = () => {
  startShutdown();
  setTimeout(() => process.exit(0), DRAIN_MS);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const original = http.createServer;
http.createServer = ((...args: unknown[]) => {
  const index = args.findIndex((argument) => typeof argument === "function");
  if (index !== -1) {
    const listener = args[index] as RequestListener;
    args[index] = ((request, response) => {
      negotiatedUrlHeaders(request, response);
      return listener(request, response);
    }) satisfies RequestListener;
  }
  return (original as (...args: unknown[]) => http.Server).apply(http, args);
}) as typeof http.createServer;
syncBuiltinESMExports();

await import(pathToFileURL(process.argv[2] ?? "").href);
