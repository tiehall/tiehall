import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { bodyLimitFor, declaredLength, negotiatedUrlHeaders, pageRouteNegotiatesHtml, payloadTooLarge, refusalAnswerAs, wayOnOfPageRoute } from "@tiehall/commands";
import { httpProblem, Refusal, type HttpProblem } from "@tiehall/core";
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
// Tiehall's own refusals), while the calls already in flight finish. A call
// counts from the moment its head arrives until its answer is done, whoever
// answers it, so the shutdown waits for a body still arriving in chunks as for
// any call in flight: a call whose head arrived before the shutdown started
// goes on to the app once its body is complete, and a new one gets its 503, or
// its 413, rather than a closed connection.
//
// Request bodies (public-api: Request bodies have a size limit;
// request-body-limit's design.md, Technical decisions: T2): the guard applies
// the size limit to every request, before any route, the setup gate or a
// token check sees it, so a body over the limit is answered 413 before any
// other refusal the call would get, a shutdown's 503 included. The limit is
// 2 MiB, 16 MiB for contract.report, and 25 MiB for a GitHub webhook
// delivery, from the one module that holds them (bodyLimitFor):
// - a request that declares a length above its limit is refused at once,
//   before any byte of its body is read; one that declares a length within
//   it is passed on as it is, since it cannot carry more than it declares;
// - a body sent in chunks, with no declared length, is counted as it arrives
//   and held until it is complete: at the byte past the limit it is refused,
//   and a complete body within the limit is passed on whole, so the app never
//   sees part of a body that is over the limit, or answers a call before its
//   size is known;
// - the refusal is the error model's 413 payload-too-large, whose detail
//   names the limit, with `Connection: close`. No more of the body is read:
//   once the answer is sent the connection is ended, and it is closed after
//   a short grace period in which it is still not read, so that the client
//   reads the 413 before the reset its unread body causes.
//
// Refusals to browsers (public-api: One error model for Tiehall's own
// refusals; github-layer-hardening: design.md, Decisions this change rests on:
// D50 (7); Technical decisions: T5): on a page route (wayOnOfPageRoute), a
// 503 or a 413 to a request that negotiates HTML there is the refusal's page,
// with the same status and headers and a link on, from the one renderer the
// routes use; every other request, and every call to /api/v1, /mcp and the
// other API paths, gets the problem. A request negotiates HTML on a request
// URL by that URL's own rule, and on every other page route when its Accept
// header names text/html (pageRouteNegotiatesHtml). A refused form's
// link leads back to the page it was posted from when its Referer names a
// page on TIEHALL_URL's origin, as a review page's form, whose target lacks
// the review page's input, needs; the Host header does not decide, since a
// proxy in front of the install may rewrite it.
//
// Request URLs (agent-surfaces: Request URL response headers): every answer
// of a request URL, /<KEY> with or without .md or .json, or of an intake page,
// whatever its method, names Accept and Authorization in its Vary and carries
// Cache-Control: private, no-store and an ETag, which the guard sets as the
// answer's head goes out, since Next.js sets its own Vary as it renders the
// web UI's page of a request, and its own Cache-Control as it answers the
// page's server action, after the proxy that negotiates the URL has run; so
// does the page's answer at a path Next.js rewrote before the proxy ran, such
// as its RSC payload's, which the proxy marks (negotiatedUrlHeaders). The
// guard's own refusals get them too.

export interface RequestGuardOptions {
  proxies: TrustedProxies;
  /** TIEHALL_URL, the install's public base URL, on whose origin the install's pages lie. */
  url: string;
}

export interface ShutdownResult {
  /** The calls in flight when the shutdown started. */
  inFlight: number;
  /** The calls still in flight when the timeout ended the wait, which closing the connections cut off. */
  cutOff: number;
}

export interface RequestGuard {
  /** The calls the guarded servers are answering now, a call whose body is still arriving included. */
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

/**
 * How long a connection whose body was refused stays ended but open, and
 * unread, before it is closed: time for the client to read the 413 before the
 * reset that closing a connection with unread data sends.
 */
export const REFUSED_BODY_GRACE_MS = 2_000;

/** The answer to a body over each limit, built once per limit. */
const refusals = new Map<number, { problem: HttpProblem; body: string }>();

/** Installs the guard on every HTTP server the process creates from now on. */
export function installRequestGuard(options: RequestGuardOptions): RequestGuard {
  const origin = new URL(options.url).origin;
  const servers = new Set<http.Server>();
  let inFlight = 0;
  let stopping = false;
  let drained: (() => void) | undefined;

  const guard = (listener: RequestListener): RequestListener => (request: IncomingMessage, response: ServerResponse) => {
    // Decided when the head arrives, not when a held body is complete.
    const newDuringShutdown = stopping;
    negotiatedUrlHeaders(request, response);
    inFlight += 1;
    response.once("close", () => {
      inFlight -= 1;
      if (stopping && inFlight === 0) drained?.();
    });
    const serve = (): void => {
      if (newDuringShutdown) return shuttingDown(request, response, origin);
      setForwardedHeaders(request, options.proxies);
      listener(request, response);
    };
    const limit = bodyLimitFor(request.method ?? "GET", pathOf(request.url));
    const declared = declaredLength(request.headers["content-length"]);
    if (declared !== undefined) return declared > limit ? refuseBody(request, response, limit, origin) : serve();
    // A request with neither a declared length nor chunks has no body.
    if (request.headers["transfer-encoding"] === undefined) return serve();
    holdBody(request, limit, serve, () => refuseBody(request, response, limit, origin));
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

function shuttingDown(request: IncomingMessage, response: ServerResponse, origin: string): void {
  // The call's body is not read; the connection closes after the answer.
  request.resume();
  refuse(request, response, SHUTTING_DOWN, SHUTTING_DOWN_BODY, origin);
}

/**
 * Writes a refusal of the guard, with `Connection: close`: on a page route,
 * the refusal's page for a request that negotiates HTML there and the problem
 * for every other, as the routes answer; elsewhere the problem, whose body is
 * given.
 */
function refuse(request: IncomingMessage, response: ServerResponse, problem: HttpProblem, problemBody: string, origin: string): void {
  const wayOn = wayOnOfPageRoute(request.method ?? "GET", request.url ?? "/", referrerOnInstall(request, origin));
  const answer =
    wayOn === undefined
      ? { status: problem.status, headers: new Headers(problem.headers), body: problemBody }
      : refusalAnswerAs(pageRouteNegotiatesHtml(request.url ?? "/", request.headers.accept), problem, wayOn);
  response.writeHead(answer.status, {
    ...Object.fromEntries(answer.headers),
    "content-length": Buffer.byteLength(answer.body),
    connection: "close",
  });
  response.end(request.method === "HEAD" ? undefined : answer.body);
}

/**
 * The page the request's Referer names, when it lies on the install's origin,
 * TIEHALL_URL's, as a form posted from one of the install's pages does: pages
 * send their Referer to the install's own origin only. Undefined otherwise.
 */
function referrerOnInstall(request: IncomingMessage, origin: string): string | undefined {
  const { referer } = request.headers;
  if (referer === undefined) return undefined;
  try {
    return new URL(referer).origin === origin ? referer : undefined;
  } catch {
    return undefined;
  }
}

/** The path a request names, without its query; "/" for a target that is not a path. */
function pathOf(target: string | undefined): string {
  try {
    return new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/**
 * Holds a body sent in chunks until it is complete, counting its bytes as the
 * connection delivers them: past the limit it calls over, and once the body
 * is complete within the limit it hands the whole body back to the request
 * and calls complete. It takes the chunks where Node puts a request's body,
 * the request's push(), so nothing reads them before the size is known.
 */
function holdBody(request: IncomingMessage, limit: number, complete: () => void, over: () => void): void {
  const held: Buffer[] = [];
  let received = 0;
  request.push = (chunk: Buffer | null): boolean => {
    if (chunk === null) {
      Reflect.deleteProperty(request, "push");
      for (const piece of held) request.push(piece);
      request.push(null);
      complete();
      return false;
    }
    received += chunk.length;
    if (received > limit) {
      held.length = 0;
      over();
      return false;
    }
    held.push(chunk);
    // Keep the connection delivering chunks, though nothing reads them yet.
    return true;
  };
}

/**
 * Answers a body over its limit with 413 and `Connection: close`, and reads
 * no more of it: what the connection still delivers is dropped, the
 * connection is not read from again, and once the answer is sent it is ended
 * and, after the grace period, closed.
 */
function refuseBody(request: IncomingMessage, response: ServerResponse, limit: number, origin: string): void {
  const socket = request.socket;
  request.push = (): boolean => false;
  // Once an answer is sent, Node resumes a request nobody read, to discard the rest of its body; not this one.
  request.resume = function (this: IncomingMessage) {
    return this;
  };
  socket.pause();
  // Node ends a connection whose answer says `Connection: close`, and closes it once the end is sent; this one
  // stays open, and unread, for the grace period first.
  socket.destroySoon = function (this: Socket) {
    this.end();
    setTimeout(() => this.destroy(), REFUSED_BODY_GRACE_MS).unref();
  };
  let refusal = refusals.get(limit);
  if (refusal === undefined) {
    const problem = httpProblem(payloadTooLarge(limit));
    refusal = { problem, body: JSON.stringify(problem.body) };
    refusals.set(limit, refusal);
  }
  refuse(request, response, refusal.problem, refusal.body, origin);
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
