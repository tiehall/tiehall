import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { TLSSocket } from "node:tls";
import { forwardedClient, type TrustedProxies } from "./trusted-proxies.ts";

// The request guard of the web role. The web role runs the Next.js
// standalone server in its own process, and installs this guard before it
// loads that server: every HTTP server the process then creates passes each
// request through the guard before its own handler sees it.
//
// Forwarded headers (self-host-install: `TIEHALL_URL` and TLS): from a peer
// that is not a trusted proxy, the guard drops Forwarded, X-Forwarded-*
// and X-Real-IP; then it sets X-Forwarded-For to the one client address the
// install trusts, and X-Forwarded-Proto to the scheme that client used. The
// app reads the client from these two headers only, so a client can never
// name its own address or scheme, and the app never sees Next.js fill them
// from an untrusted peer.

export interface RequestGuardOptions {
  proxies: TrustedProxies;
}

/** The headers a client could use to name its own address, host or scheme. */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip"];

/** Installs the guard on every HTTP server the process creates from now on, and returns how to remove it. */
export function installRequestGuard(options: RequestGuardOptions): () => void {
  const original = http.createServer;
  const guarded = ((...args: unknown[]) => {
    const index = args.findIndex((argument) => typeof argument === "function");
    if (index !== -1) args[index] = guardListener(args[index] as RequestListener, options);
    return (original as (...args: unknown[]) => http.Server).apply(http, args);
  }) as typeof http.createServer;
  http.createServer = guarded;
  // Also for code that imported createServer by name.
  syncBuiltinESMExports();
  return () => {
    if (http.createServer === guarded) http.createServer = original;
    syncBuiltinESMExports();
  };
}

function guardListener(listener: RequestListener, options: RequestGuardOptions): RequestListener {
  return (request: IncomingMessage, response: ServerResponse) => {
    setForwardedHeaders(request, options.proxies);
    return listener(request, response);
  };
}

/** Rewrites a request's forwarded headers to the client the install trusts. */
export function setForwardedHeaders(request: IncomingMessage, proxies: TrustedProxies): void {
  const peer = request.socket.remoteAddress ?? "";
  const tls = (request.socket as Partial<TLSSocket>).encrypted === true;
  const trusted = proxies.isTrusted(peer);
  // A proxy named by a host name may have restarted with a new address: look the names up again.
  if (!trusted && FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined)) proxies.refreshSoon();
  const client = forwardedClient(peer, request.headers, tls, proxies);
  if (!trusted) for (const name of FORWARDED_HEADERS) delete request.headers[name];
  delete request.headers["forwarded"];
  delete request.headers["x-real-ip"];
  request.headers["x-forwarded-for"] = client.address;
  request.headers["x-forwarded-proto"] = client.scheme;
}
