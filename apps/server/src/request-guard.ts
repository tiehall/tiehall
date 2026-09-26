import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { TLSSocket } from "node:tls";
import { httpProblem, Refusal } from "@tiehall/core";
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
//
// Shutdown (self-host-install: A restart stops the app gracefully): once the
// web role starts to stop, the guard answers every new call itself, with 503,
// `Retry-After: 0` and an RFC 9457 problem (public-api: One error model for
// Tiehall's own refusals), while the calls already in flight finish.

export interface RequestGuardOptions {
  proxies: TrustedProxies;
}

export interface ShutdownResult {
  /** The calls in flight when the shutdown started. */
  inFlight: number;
  /** The calls still in flight when the timeout ended the wait, which closing the connections cut off. */
  cutOff: number;
}

export interface RequestGuard {
  /** The calls the guarded servers are answering now. */
  readonly inFlight: number;
  /**
   * Answers every new call with 503 from now on, waits until the calls in
   * flight have finished or the timeout has passed, and then closes the
   * servers and every connection they hold.
   */
  shutdown(timeoutMs: number): Promise<ShutdownResult>;
  /** Stops guarding servers created from now on. */
  uninstall(): void;
}

/** The headers a client could use to name its own address, host or scheme. */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip"];

/** The answer a call gets while the app shuts down: the error model's 503 with `Retry-After: 0`. */
const SHUTTING_DOWN = httpProblem(
  new Refusal("shutting-down", "Tiehall is shutting down. Retry the call; it is answered once Tiehall is back."),
);
const SHUTTING_DOWN_BODY = JSON.stringify(SHUTTING_DOWN.body);

/** Installs the guard on every HTTP server the process creates from now on. */
export function installRequestGuard(options: RequestGuardOptions): RequestGuard {
  const servers = new Set<http.Server>();
  let inFlight = 0;
  let stopping = false;
  let drained: (() => void) | undefined;

  const guard = (listener: RequestListener): RequestListener => (request: IncomingMessage, response: ServerResponse) => {
    if (stopping) return shuttingDown(request, response);
    setForwardedHeaders(request, options.proxies);
    inFlight += 1;
    response.once("close", () => {
      inFlight -= 1;
      if (stopping && inFlight === 0) drained?.();
    });
    return listener(request, response);
  };

  const original = http.createServer;
  const guarded = ((...args: unknown[]) => {
    const index = args.findIndex((argument) => typeof argument === "function");
    if (index !== -1) args[index] = guard(args[index] as RequestListener);
    const server = (original as (...args: unknown[]) => http.Server).apply(http, args);
    servers.add(server);
    return server;
  }) as typeof http.createServer;
  http.createServer = guarded;
  // Also for code that imported createServer by name.
  syncBuiltinESMExports();

  return {
    get inFlight() {
      return inFlight;
    },
    async shutdown(timeoutMs) {
      stopping = true;
      const atStart = inFlight;
      if (inFlight > 0) {
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
          drained = resolve;
          timer = setTimeout(resolve, timeoutMs);
        });
        clearTimeout(timer);
      }
      const cutOff = inFlight;
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
      return { inFlight: atStart, cutOff };
    },
    uninstall() {
      if (http.createServer === guarded) http.createServer = original;
      syncBuiltinESMExports();
    },
  };
}

function shuttingDown(request: IncomingMessage, response: ServerResponse): void {
  // The call's body is not read; the connection closes after the answer.
  request.resume();
  response.writeHead(SHUTTING_DOWN.status, {
    ...SHUTTING_DOWN.headers,
    "content-length": Buffer.byteLength(SHUTTING_DOWN_BODY),
    connection: "close",
  });
  response.end(request.method === "HEAD" ? undefined : SHUTTING_DOWN_BODY);
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
