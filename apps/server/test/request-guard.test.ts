import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createBodiesInFlight, type BodiesInFlight } from "@tiehall/commands";
import { installRequestGuard, type RequestGuard } from "../src/request-guard.ts";
import { TrustedProxies } from "../src/trusted-proxies.ts";

// public-api: Request bodies have a size limit (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (5); Technical decisions: T1).
// Besides each body's own limit, one web process holds at most 64 MiB of
// request bodies being received at once, in the counter the web role's request
// guard reserves from. A body holds the bytes of it that have arrived, whether
// its request declares its length or sends it in chunks, so a request that
// declares a length and sends nothing holds none of the cap (the maintainer's
// answer of 2026-10-12 to the open question "Bodies declared and not sent"). A
// body whose bytes would take the bytes held past the cap as they arrive is
// answered 503 busy, and read no further. What a body held is released
// whichever way it ends: read by the app, refused, abandoned by its client
// mid-body, or closed by the server's own request timeout, so no reservation is
// ever left behind. These tests run the guard in this process, on a counter of
// their own, so they read what it holds; web-role.test.ts runs the web role.

const MiB = 1024 * 1024;
const BUSY = "https://tiehall.com/problems/busy";

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Install {
  port: number;
  bodies: BodiesInFlight;
  guard: RequestGuard;
  /** The method and path of every call the app behind the guard was handed. */
  seen: string[];
  /** Every connection the server took, in the order it took them. */
  sockets: Socket[];
}

let installed: { guard: RequestGuard; server: http.Server } | undefined;
const clients: http.ClientRequest[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  if (installed !== undefined) {
    const { guard, server } = installed;
    installed = undefined;
    guard.uninstall();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Installs the guard on a counter of its own and starts a server behind it, as the Next.js standalone server is
 * started, whose app reads every body it is handed and answers 200 with the bytes it read. With a request timeout,
 * the server ends a call whose request has not fully arrived after that many milliseconds, as Node's own 300-second
 * timeout does, and checks for such calls often.
 */
async function start(requestTimeoutMs?: number): Promise<Install> {
  const bodies = createBodiesInFlight();
  const guard = installRequestGuard({ proxies: new TrustedProxies([]), url: "https://tiehall.example.com", bodies });
  const seen: string[] = [];
  const options: http.ServerOptions =
    requestTimeoutMs === undefined ? {} : { requestTimeout: requestTimeoutMs, headersTimeout: requestTimeoutMs, connectionsCheckingInterval: 50 };
  const server = http.createServer(options, (request, response) => {
    seen.push(`${request.method} ${request.url}`);
    let bytes = 0;
    request.on("data", (chunk: Buffer) => (bytes += chunk.length));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`read ${bytes} bytes`);
    });
  });
  const sockets: Socket[] = [];
  server.on("connection", (socket: Socket) => sockets.push(socket));
  installed = { guard, server };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, bodies, guard, seen, sockets };
}

/** Waits until the check holds, failing after the given seconds. */
async function until(what: string, check: () => boolean, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

function collect(response: http.IncomingMessage): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => (body += chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    response.on("error", reject);
  });
}

/** A POST to this path, which declares a body of this many bytes, or sends its body in chunks when it declares none. */
function post(install: Install, path: string, declared?: number): http.ClientRequest {
  const request = http.request({
    host: "127.0.0.1",
    port: install.port,
    method: "POST",
    path,
    agent: false,
    headers: { "content-type": "application/json", ...(declared === undefined ? {} : { "content-length": String(declared) }) },
  });
  request.on("error", () => {});
  clients.push(request);
  return request;
}

/**
 * Starts a POST whose body is this many bytes long, declared or in chunks, sends this many of them, and holds the
 * rest back, as a slow client does; it waits until the guard has the call, and the bytes sent have arrived.
 */
async function holdOpen(install: Install, path: string, sent: number, declared?: number): Promise<http.ClientRequest> {
  const calls = install.guard.inFlight;
  const before = install.bodies.held;
  const request = post(install, path, declared);
  if (sent === 0) request.flushHeaders();
  else request.write(Buffer.alloc(sent, " "));
  await until(`the guard to have the call to ${path}`, () => install.guard.inFlight > calls);
  // A body sent in chunks carries its framing too, which counts nothing.
  await until(`the ${sent} bytes sent to ${path} to arrive`, () => install.bodies.held >= before + sent);
  return request;
}

/**
 * Sends a POST whose body of this many bytes goes in 64 KiB pieces, declared or in chunks, until it is all sent or
 * the call is answered, and returns the answer with how many bytes had been written when it came.
 */
function send(install: Install, path: string, bytes: number, declared: boolean): Promise<Answer & { writtenBefore: number }> {
  const request = post(install, path, declared ? bytes : undefined);
  const piece = Buffer.alloc(64 * 1024, " ");
  let written = 0;
  return new Promise((resolve, reject) => {
    let answered = false;
    request.on("response", (response) => {
      answered = true;
      const writtenBefore = written;
      void collect(response).then((answer) => resolve({ ...answer, writtenBefore }), reject);
    });
    request.on("error", (error) => {
      if (!answered) reject(error);
    });
    const next = (): void => {
      while (!answered && written < bytes) {
        const part = piece.subarray(0, Math.min(piece.length, bytes - written));
        written += part.length;
        if (!request.write(part)) {
          request.once("drain", next);
          return;
        }
      }
      if (!answered) request.end();
    };
    next();
  });
}

function expectBusy(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.headers["retry-after"]).toBe("5");
  expect(answer.headers["connection"]).toBe("close");
  expect(JSON.parse(answer.body)).toMatchObject({ type: BUSY, status: 503, retryAfter: 5 });
}

describe("the request guard's cap on bodies being received at once", () => {
  it("lets requests that declare 25, 25 and 14 MiB to /webhooks/github and send nothing hold none of it, so a delivery is not refused", async () => {
    const install = await start();
    for (const declared of [25 * MiB, 25 * MiB, 14 * MiB]) await holdOpen(install, "/webhooks/github", 0, declared);
    expect(install.guard.inFlight).toBe(3);
    expect(install.bodies.held).toBe(0);

    const delivery = await send(install, "/webhooks/github", 25 * MiB, true);
    expect(delivery.status).toBe(200);
    expect(delivery.body).toBe(`read ${25 * MiB} bytes`);
    // The delivery's bytes were released once the app had read them.
    expect(install.bodies.held).toBe(0);
  });

  it("holds a declared body's bytes as they arrive, and answers 503 busy at the bytes that would take them past 64 MiB, reading no further", async () => {
    const install = await start();
    const sent = 25 * MiB - 1024;
    for (let held = 0; held < 2; held += 1) await holdOpen(install, "/webhooks/github", sent, 25 * MiB);
    expect(install.bodies.held).toBe(2 * sent);

    const answer = await send(install, "/api/v1/contract-reports", 15 * MiB, true);
    expectBusy(answer);
    // 50 MiB less 2 KiB are held, so the report passes the 64 MiB a little after its 14th MiB has arrived, and not
    // when its head does; its connection read no more than the one socket read, of at most 64 KiB, that held the
    // bytes past the cap, besides the request's head.
    expect(answer.writtenBefore).toBeGreaterThan(14 * MiB);
    const refused = install.sockets[2]!;
    expect(refused.bytesRead).toBeGreaterThan(14 * MiB);
    expect(refused.bytesRead).toBeLessThanOrEqual(14 * MiB + 2048 + 128 * 1024);
    expect(install.seen).toEqual([]);
    // The refused report holds nothing; the two bodies still arriving hold what arrived of them.
    await until("the refused report's bytes to be released", () => install.bodies.held === 2 * sent);
  });

  it("releases what a body held when its client closes the connection mid-body, whether it declared its length or not", async () => {
    const install = await start();
    const declared = await holdOpen(install, "/webhooks/github", 10 * MiB, 25 * MiB);
    const chunked = await holdOpen(install, "/webhooks/github", 10 * MiB);
    expect(install.bodies.held).toBe(20 * MiB);

    declared.destroy();
    await until("the declared body's bytes to be released", () => install.bodies.held === 10 * MiB);
    chunked.destroy();
    await until("every body's bytes to be released", () => install.bodies.held === 0 && install.guard.inFlight === 0);
    expect(install.seen).toEqual([]);
  });

  it("releases what a body held when the server's request timeout ends a call whose body stopped arriving", async () => {
    const install = await start(2_000);
    const sent = 25 * MiB - 1024;
    const declared = await holdOpen(install, "/webhooks/github", sent, 25 * MiB);
    const chunked = await holdOpen(install, "/webhooks/github", sent);
    expect(install.bodies.held).toBe(2 * sent);
    const timedOut = new Promise<void>((resolve) => chunked.once("close", () => resolve()));

    // One client closes its connection; the other sends nothing more, and the server's request timeout ends its call.
    declared.destroy();
    await timedOut;
    await until("every body's bytes to be released", () => install.bodies.held === 0 && install.guard.inFlight === 0);
    expect(install.seen).toEqual([]);

    // The room is there again: a report of 15 MiB is not refused for the cap.
    const report = await send(install, "/api/v1/contract-reports", 15 * MiB, true);
    expect(report.status).toBe(200);
    expect(report.body).toBe(`read ${15 * MiB} bytes`);
  });
});
