import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  bodiesBusy,
  bodiesInFlight,
  bodyLimitFor,
  declaredLength,
  negotiatedUrlHeaders,
  pageRouteNegotiatesHtml,
  payloadTooLarge,
  refusalAnswerAs,
  wayOnOfPageRoute,
  type BodiesInFlight,
} from "@tiehall/commands";
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
// answers it, so the shutdown waits for a body still arriving as for any call
// in flight: a call whose head arrived before the shutdown started goes on to
// the app once its body is complete, and a new one gets its 503, or its 413,
// rather than a closed connection: at once when its request declares a
// length, since no byte of a body within its limit could change that answer,
// and once its body is complete when it comes in chunks, whose size is known
// only then.
//
// Request bodies (public-api: Request bodies have a size limit;
// request-body-limit's design.md, Technical decisions: T2): the guard applies
// the size limit to every request, before any route, the setup gate or a
// token check sees it, so a body over the limit is answered 413 before any
// other refusal the call would get, a shutdown's 503 included. The limit is
// 2 MiB, 16 MiB for contract.report, and 25 MiB for a GitHub webhook
// delivery, from the one module that holds them (bodyLimitFor):
// - a request that declares a length above its limit is refused at once,
//   before any byte of its body is read;
// - every other body, whether its request declares its length or sends it in
//   chunks, is counted as it arrives and held until it is complete: a body
//   sent in chunks is refused at the byte past the limit, and a complete body
//   within the limit is passed on whole, so the app never sees part of a body
//   that is over the limit, or answers a call before its body has arrived;
// - the refusal is the error model's 413 payload-too-large, whose detail
//   names the limit, with `Connection: close`. No more of the body is read:
//   once the answer is sent the connection is ended, and it is closed after
//   a short grace period in which it is still not read, so that the client
//   reads the 413 before the reset its unread body causes.
//
// Bodies being received at once (public-api: Request bodies have a size
// limit; decisions-from-groups-15-28: design.md, Decisions this change rests
// on: D55 (5); Technical decisions: T1): besides each body's own limit, the
// process holds at most 64 MiB of request bodies being received at once, in
// the one counter of the body limits' module (bodiesInFlight), on every path,
// since every route that reads a body reads it before it knows who calls:
// - a body reserves each of its chunks as it arrives, while the guard holds
//   it, whether its request declares its length or sends it in chunks, so a
//   request that declares a length and sends nothing holds none of the cap
//   (the maintainer's answer of 2026-10-12 to the open question "Bodies
//   declared and not sent": a declared length reserved when the head arrived
//   let a client that sent nothing hold it until Node's 300-second request
//   timeout);
// - a body the guard holds is copied into one buffer that grows as its bytes
//   arrive, to at most twice their number, and none of the chunks Node hands
//   over is kept: each is an object of its own, of some 200 bytes of heap
//   however few bytes it carries, so a body sent in small chunks would take
//   many times the memory the cap counts for it (holdBody);
// - a body whose chunk would take the bytes reserved past the cap is answered
//   at once with the error model's 503 busy, `Retry-After: 5` and
//   `Connection: close`, and is read no further, as a body over its limit is.
//   A body over its own limit still gets its 413 first, and the cap comes
//   before every other refusal, a shutdown's 503 included;
// - what a body reserved is released once it is done with: read by the app,
//   refused, abandoned by its client, or ended by the server's request
//   timeout, or once its answer has gone out.
//
// Methods no route takes (agent-surfaces: Negotiated request URLs; public-api:
// One error model for Tiehall's own refusals; decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (42)): a call with TRACE, a
// method the Fetch standard forbids, never reaches the app, which could not
// build its Request and would answer 500; the guard answers it, on every path,
// with the error model's 404 route-not-found, once the body limit and a
// shutdown have had their say. It is the only such method that reaches the
// guard: Node's parser refuses TRACK itself, with a bare 400, and hands
// CONNECT to the server's connect event, never to a request listener.
//
// Refusals to browsers (public-api: One error model for Tiehall's own
// refusals; github-layer-hardening: design.md, Decisions this change rests on:
// D50 (7); Technical decisions: T5): on a page route (wayOnOfPageRoute), a
// 503 or a 413 to a request that negotiates HTML there is the refusal's page,
// with the same status and headers and a link on, from the one renderer the
// routes use; every other request, and every call to /api/v1, /mcp and the
// other API paths, gets the problem. A request negotiates HTML on a request
// URL by that URL's own rule, and on every other page route when its Accept
// header names text/html with a quality above 0 (pageRouteNegotiatesHtml). A
// refused form's link leads back to the page it was posted from when its
// Referer names a page on TIEHALL_URL's origin, as a review page's form, whose
// target lacks the review page's input, needs; the Host header does not
// decide, since a proxy in front of the install may rewrite it.
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
  /** The bytes of request bodies the process is receiving, under the cap; the process's one counter unless given. */
  bodies?: BodiesInFlight;
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
 * The methods the Fetch standard forbids that reach the guard, which Next.js
 * cannot build a Request of, so no route takes them: TRACE alone, since Node's
 * parser refuses TRACK with a bare 400 and hands CONNECT to the server's
 * connect event.
 */
const FORBIDDEN_METHODS = new Set(["TRACE"]);
/** The answer to a call with one of them: the error model's 404 for a route the surface does not offer. */
const NO_ROUTE = httpProblem(new Refusal("route-not-found", "No route here takes this method."));
const NO_ROUTE_BODY = JSON.stringify(NO_ROUTE.body);

/**
 * How long a connection whose body was refused stays ended but open, and
 * unread, before it is closed: time for the client to read the 413 before the
 * reset that closing a connection with unread data sends.
 */
export const REFUSED_BODY_GRACE_MS = 2_000;

/** The answer to a body over each limit, built once per limit. */
const refusals = new Map<number, { problem: HttpProblem; body: string }>();

/** The answer to a body that would take the bodies being received past the cap: the error model's 503 busy. */
const BUSY = httpProblem(bodiesBusy());
const BUSY_BODY = JSON.stringify(BUSY.body);

/** Installs the guard on every HTTP server the process creates from now on. */
export function installRequestGuard(options: RequestGuardOptions): RequestGuard {
  const origin = new URL(options.url).origin;
  const bodies = options.bodies ?? bodiesInFlight;
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
      if (FORBIDDEN_METHODS.has((request.method ?? "GET").toUpperCase())) return noRoute(request, response, origin);
      setForwardedHeaders(request, options.proxies);
      listener(request, response);
    };
    const limit = bodyLimitFor(request.method ?? "GET", pathOf(request.url));
    const declared = declaredLength(request.headers["content-length"]);
    if (declared !== undefined && declared > limit) return refuseBody(request, response, limit, origin);
    // A request that declares an empty body, or neither a length nor chunks, has no body.
    if (declared === 0 || (declared === undefined && request.headers["transfer-encoding"] === undefined)) return serve();
    // A new call during a shutdown that declares a length within its limit gets its 503 at once: no byte of its body
    // could change that answer.
    if (newDuringShutdown && declared !== undefined) return serve();
    // Every other body, declared or in chunks, reserves its bytes as they arrive, and nothing before.
    let reserved = 0;
    const release = whenDone(request, response, () => bodies.release(reserved));
    holdBody(
      request,
      declared ?? limit,
      limit,
      (bytes) => {
        if (!bodies.reserve(bytes)) return false;
        reserved += bytes;
        return true;
      },
      serve,
      () => {
        release();
        refuseBody(request, response, limit, origin);
      },
      () => {
        release();
        refuseBusy(request, response, origin);
      },
    );
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

function noRoute(request: IncomingMessage, response: ServerResponse, origin: string): void {
  // The call's body is not read; the connection closes after the answer.
  request.resume();
  refuse(request, response, NO_ROUTE, NO_ROUTE_BODY, origin);
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
 * Calls release once, when the request is done with: its body read to its
 * end, the request closed, or its answer gone out. Returns a release that may
 * be called earlier, which the later events then leave alone.
 */
function whenDone(request: IncomingMessage, response: ServerResponse, release: () => void): () => void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    release();
  };
  request.once("end", once);
  request.once("close", once);
  response.once("close", once);
  return once;
}

/** What a body the guard holds has before its first byte arrives. */
const NOTHING_HELD = Buffer.alloc(0);

/**
 * Holds a body until it is complete, whether its request declares its length
 * or sends it in chunks, counting its bytes as the connection delivers them:
 * past the limit it calls over, and at a chunk that reserve refuses, because
 * it would take the bodies being received past the cap, it calls busy; once
 * the body is complete within the limit it hands the whole body back to the
 * request and calls complete. It takes the chunks where Node puts a request's
 * body, the request's push(), so nothing reads them before the size is known.
 *
 * It copies each chunk into one buffer that grows as the bytes arrive, and
 * keeps none of the chunks: Node hands over each chunk as an object of its
 * own, of some 200 bytes of heap however few bytes it carries, so a body
 * kept chunk by chunk and sent a byte per chunk took some 200 times the
 * memory the cap counts for it. The buffer doubles when it is full, so the
 * bytes copied come to less than three times the body's in all; it is never
 * more than twice the bytes that have arrived, nor more than the most the
 * body may hold: its declared length, or else its limit.
 */
function holdBody(
  request: IncomingMessage,
  most: number,
  limit: number,
  reserve: (bytes: number) => boolean,
  complete: () => void,
  over: () => void,
  busy: () => void,
): void {
  let held = NOTHING_HELD;
  let received = 0;
  request.push = (chunk: Buffer | null): boolean => {
    if (chunk === null) {
      Reflect.deleteProperty(request, "push");
      if (received > 0) request.push(held.subarray(0, received));
      request.push(null);
      complete();
      return false;
    }
    const needed = received + chunk.length;
    if (needed > limit) {
      held = NOTHING_HELD;
      over();
      return false;
    }
    if (!reserve(chunk.length)) {
      held = NOTHING_HELD;
      busy();
      return false;
    }
    if (needed > held.length) {
      const grown = Buffer.alloc(Math.max(needed, Math.min(most, 2 * held.length)));
      held.copy(grown, 0, 0, received);
      held = grown;
    }
    chunk.copy(held, received);
    received = needed;
    // Keep the connection delivering chunks, though nothing reads them yet.
    return true;
  };
}

/**
 * Answers a body over its limit with 413 and `Connection: close`, and reads
 * no more of it (refuseUnread).
 */
function refuseBody(request: IncomingMessage, response: ServerResponse, limit: number, origin: string): void {
  let refusal = refusals.get(limit);
  if (refusal === undefined) {
    const problem = httpProblem(payloadTooLarge(limit));
    refusal = { problem, body: JSON.stringify(problem.body) };
    refusals.set(limit, refusal);
  }
  refuseUnread(request, response, refusal.problem, refusal.body, origin);
}

/**
 * Answers a body that would take the bodies being received past the cap with
 * 503 busy and `Connection: close`, and reads no more of it (refuseUnread).
 */
function refuseBusy(request: IncomingMessage, response: ServerResponse, origin: string): void {
  refuseUnread(request, response, BUSY, BUSY_BODY, origin);
}

/**
 * Answers a body the guard refuses, and reads no more of it: what the
 * connection still delivers is dropped, the connection is not read from
 * again, and once the answer is sent it is ended and, after the grace period,
 * closed.
 */
function refuseUnread(request: IncomingMessage, response: ServerResponse, problem: HttpProblem, problemBody: string, origin: string): void {
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
  refuse(request, response, problem, problemBody, origin);
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
