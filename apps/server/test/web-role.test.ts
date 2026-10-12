import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tiehall/commands";
import { createTestDatabase, type TestDatabase } from "@tiehall/testing/postgres";

// The web role stops gracefully (self-host-install: A restart stops the app
// gracefully; public-api: One error model for Tiehall's own refusals). Docker
// sends SIGTERM when Compose stops or replaces the app container. From then
// on, every new call is answered 503 with `Retry-After: 0`, as an RFC 9457
// problem, so clients retry once the app is back; the calls already in flight
// finish; then the role exits 0. The worker's side, where a job interrupted by
// the stop runs again after the restart, is tested in worker-role.test.ts.

const fixture = fileURLToPath(new URL("./support/web-with-fixture-server.ts", import.meta.url));

/** What a browser sends, which names text/html. */
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

interface Running {
  child: ChildProcess;
  port: number;
  /** Everything the process wrote, standard output and standard error together. */
  output: () => string;
  /** What it wrote to standard output alone. */
  stdout: () => string;
  exited: Promise<number | null>;
}

let running: Running | undefined;

afterEach(() => {
  running?.child.kill("SIGKILL");
  running = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Waits until the check holds, failing after the given seconds. The role
 * listens within a second on a laptop, but a loaded CI runner took longer than
 * 20 seconds twice, so the default is a minute, and the tests that start the
 * role have two (STARTS_THE_ROLE).
 */
async function until(what: string, check: () => boolean, seconds = 60): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The tests that start the role give it two minutes, so the minute the role may take to listen fits in. */
const STARTS_THE_ROLE = { timeout: 120_000 };

async function startWebRole(env: Record<string, string> = {}): Promise<Running> {
  const port = await freePort();
  const child = spawn(process.execPath, [fixture], {
    env: {
      PATH: process.env["PATH"] ?? "",
      PORT: String(port),
      TIEHALL_URL: "http://localhost:3000",
      TIEHALL_DATABASE_APP_PASSWORD: "unused",
      TIEHALL_SECRET_KEY: randomBytes(32).toString("base64url"),
      TIEHALL_AUTH_SECRET: randomBytes(32).toString("base64url"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  running = { child, port, output: () => output, stdout: () => stdout, exited };
  await until("the server to listen", () => output.includes("fixture: listening"));
  return running;
}

function logEntries(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the web role on SIGTERM", STARTS_THE_ROLE, () => {
  it("answers a call during shutdown with 503, Retry-After: 0 and a problem, lets the call in flight finish, and exits 0", async () => {
    const web = await startWebRole();
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }));
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));

    web.child.kill("SIGTERM");
    await until("the role to start stopping", () => web.output().includes("web: stopping"));
    const during = await fetch(`http://127.0.0.1:${web.port}/api/v1/requests`, { method: "POST", body: "{}" });
    expect(during.status).toBe(503);
    expect(during.headers.get("retry-after")).toBe("0");
    expect(during.headers.get("content-type")).toBe("application/problem+json");
    expect(await during.json()).toEqual({
      type: "https://tiehall.com/problems/shutting-down",
      title: "Tiehall is shutting down",
      status: 503,
      detail: "Tiehall is shutting down. Retry the call; it is answered once Tiehall is back.",
      retryAfter: 0,
    });

    expect(await slow).toEqual({ status: 200, body: "slow call done" });
    expect(await web.exited).toBe(0);
    expect(logEntries(web.output()).map(({ msg }) => msg)).toEqual([
      "▲ Next.js 16.3.5",
      `- Local: http://localhost:${web.port}`,
      "✓ Ready in 0ms",
      "fixture: listening",
      "fixture: slow call started",
      "web: stopping; new calls get 503 until the 1 call in flight finishes",
      "web: stopped",
    ]);
  });

  // public-api: One error model for Tiehall's own refusals (github-layer-hardening: design.md, Decisions this
  // change rests on: D50 (7)). On the routes that serve the web UI's pages, the setup screen, the review pages
  // under /confirm/… and GitHub's return to either sign-in callback, a browser, whose Accept header names
  // text/html, gets the 503 as a page with a link on; a client that asks for JSON there, and every call to
  // /api/v1, /mcp and the sign-in service's other routes, whatever it accepts, gets the problem.
  it("answers a browser that opens a page during shutdown with 503 as a page that leads on, and every other call with the problem", async () => {
    // The slow call stays in flight while the test makes its calls.
    const web = await startWebRole({ SLOW_MS: "5000" });
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).then((response) => response.text());
    // Awaited below; this only keeps a failure before then from counting as unhandled.
    slow.catch(() => undefined);
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));
    web.child.kill("SIGTERM");
    await until("the role to start stopping", () => web.output().includes("web: stopping"));
    const open = (path: string, accept: string) => fetch(`http://127.0.0.1:${web.port}${path}`, { headers: { accept } });

    for (const [path, wayOn] of [
      ["/members", "/members"],
      ["/confirm/members.change_role?input=%7B%7D", "/confirm/members.change_role?input=%7B%7D"],
      ["/api/auth/callback/github?code=c&state=s", "/sign-in"],
      ["/setup/sign-in/callback/github?code=c&state=s", "/setup"],
    ] as const) {
      const page = await open(path, BROWSER);
      expect(page.status, path).toBe(503);
      expect(page.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(page.headers.get("retry-after"), path).toBe("0");
      expect(page.headers.get("connection"), path).toBe("close");
      expect(page.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      const markup = await page.text();
      expect(markup, path).toContain("<h1>Tiehall is shutting down</h1>");
      expect(markup, path).toContain("<code>https://tiehall.com/problems/shutting-down</code>");
      expect(markup, path).toContain(`<a class="button" href="${wayOn}">`);
      expect(markup, path).not.toContain("<script");
    }
    for (const [path, accept] of [
      ["/members", "application/json"],
      ["/api/v1/requests", BROWSER],
      ["/mcp", BROWSER],
      ["/api/auth/get-session", BROWSER],
    ] as const) {
      const answer = await open(path, accept);
      expect(answer.status, path).toBe(503);
      expect(answer.headers.get("content-type"), path).toBe("application/problem+json");
      expect(await answer.json(), path).toMatchObject({ type: "https://tiehall.com/problems/shutting-down", status: 503 });
    }
    // A request URL negotiates HTML by its own rule (agent-surfaces: Negotiated request URLs): a call without an
    // Accept header, or one that accepts any type, gets the page there, and its .md and .json forms the problem;
    // each answer names Accept and Authorization in its Vary (agent-surfaces: Request URL response headers).
    for (const accept of [BROWSER, "*/*"]) {
      const page = await open("/FE-142", accept);
      expect(page.status, accept).toBe(503);
      expect(page.headers.get("content-type"), accept).toBe("text/html; charset=utf-8");
      expect(page.headers.get("vary"), accept).toBe("Accept, Authorization");
      expect(await page.text(), accept).toContain('<a class="button" href="/FE-142">');
    }
    for (const [path, accept] of [
      ["/FE-142.json", BROWSER],
      ["/FE-142", "text/markdown"],
    ] as const) {
      const answer = await open(path, accept);
      expect(answer.status, path).toBe(503);
      expect(answer.headers.get("content-type"), path).toBe("application/problem+json");
      expect(answer.headers.get("vary"), path).toBe("Accept, Authorization");
    }
    // A call with an Authorization header negotiates no HTML there, so it gets the problem whatever it accepts
    // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (38)).
    for (const path of ["/FE-142", "/FE"]) {
      const answer = await fetch(`http://127.0.0.1:${web.port}${path}`, { headers: { accept: BROWSER, authorization: "Bearer th_pat_reader" } });
      expect(answer.status, path).toBe(503);
      expect(answer.headers.get("content-type"), path).toBe("application/problem+json");
    }
    expect(await slow).toBe("slow call done");
    expect(await web.exited).toBe(0);
  });

  it("exits at once when no call is in flight", async () => {
    const web = await startWebRole();
    const started = Date.now();
    web.child.kill("SIGTERM");
    expect(await web.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // requester-loop: The long-poll wait endpoint, "The app shuts down during a wait". The role's stop signals the
  // process's shutdown, which the app's waits listen to: a wait in flight ends at once with 503 and Retry-After: 0,
  // long before the drain timeout, so the role stops as soon as its other calls finish.
  it("ends a wait in flight at once with 503 and Retry-After: 0, and exits 0 well before its drain timeout", async () => {
    const web = await startWebRole();
    const waiting = fetch(`http://127.0.0.1:${web.port}/api/v1/events/wait?cursor=0`).then(async (response) => ({
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: (await response.json()) as unknown,
    }));
    await until("the wait to start", () => web.output().includes("fixture: wait started"));
    const stopped = Date.now();
    web.child.kill("SIGTERM");
    expect(await waiting).toEqual({
      status: 503,
      retryAfter: "0",
      body: expect.objectContaining({ type: "https://tiehall.com/problems/shutting-down", status: 503 }),
    });
    expect(await web.exited).toBe(0);
    expect(Date.now() - stopped).toBeLessThan(5_000);
    expect(logEntries(web.output()).map(({ msg }) => msg)).toContain("web: stopped");
  });

  it("stops waiting for calls in flight after its drain timeout, and says how many it cut off", async () => {
    const web = await startWebRole({ SLOW_MS: "60000", DRAIN_TIMEOUT_MS: "300" });
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).catch(() => "cut off");
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));
    web.child.kill("SIGTERM");
    expect(await web.exited).toBe(0);
    expect(await slow).toBe("cut off");
    expect(logEntries(web.output()).map(({ msg }) => msg)).toContain("web: stopped; cut off 1 call still in flight after 300 ms");
  });
});

// self-host-install: Logs carry ids, never message text or credentials. The logs are JSON on standard output,
// what the server the role loads prints to the console included.
// agent-surfaces: Request URL response headers. Next.js sets its own Vary as it renders the web UI's page of a
// request, after the proxy ran; the web role adds Accept and Authorization to the Vary of every answer of a request
// URL as its head goes out, and leaves every other answer as it is.
describe("the web role's answers of request URLs", STARTS_THE_ROLE, () => {
  it("name Accept and Authorization in their Vary, besides what the page set, and leave other answers as they are", async () => {
    const web = await startWebRole();
    const vary = async (path: string) => (await fetch(`http://127.0.0.1:${web.port}${path}`)).headers.get("vary");
    expect(await vary("/FE-142")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(await vary("/FE-142.md")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(await vary("/members/page")).toBe("rsc, next-router-state-tree");
  });
});

// agent-surfaces: Negotiated request URLs; public-api: One error model for Tiehall's own refusals
// (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (42)). A method the Fetch standard
// forbids, such as TRACE, is one no route takes, and one Next.js cannot hand its proxy or a route: it cannot build
// the call's Request, and answers 500, as the fixture does. The web role's request guard answers such a call itself,
// on every path, with 404 route-not-found, as the error model's row for a route the surface does not offer: the
// refusal's page to a call that negotiates HTML on a page route, a request URL by its own negotiation, and the problem
// to every other call, with the headers of every answer of a request URL on one. The app never sees the call.
describe("the web role's answer to a method no route takes", STARTS_THE_ROLE, () => {
  const ROUTE_NOT_FOUND = "https://tiehall.com/problems/route-not-found";

  /** Calls the role with TRACE at this path, with exactly these headers. */
  function trace(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: "127.0.0.1", port, path, method: "TRACE", headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        response.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  it("answers TRACE on every path with 404 route-not-found, a page where the call negotiates HTML, before the app sees it", async () => {
    const web = await startWebRole();

    for (const [path, headers] of [
      ["/FE-142", { accept: BROWSER }],
      ["/FE-142", {}],
      ["/", { accept: BROWSER }],
    ] as const) {
      const page = await trace(web.port, path, headers);
      expect(page.status, path).toBe(404);
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(page.body).toContain(`<code>${ROUTE_NOT_FOUND}</code>`);
    }

    for (const [path, headers] of [
      ["/FE-142", { accept: "application/json", authorization: "Bearer th_pat_unused" }],
      ["/FE-142.json", {}],
      ["/FE-142.md", { accept: BROWSER }],
      ["/api/v1/inbox", { accept: BROWSER }],
      ["/mcp", {}],
    ] as const) {
      const problem = await trace(web.port, path, headers);
      expect(problem.status, path).toBe(404);
      expect(problem.headers["content-type"]).toBe("application/problem+json");
      expect(JSON.parse(problem.body)).toMatchObject({ type: ROUTE_NOT_FOUND, status: 404 });
    }

    // A request URL's answer carries the headers of every answer of one.
    const answer = await trace(web.port, "/FE-142.md");
    expect(answer.headers["vary"]).toBe("Accept, Authorization");
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.headers["etag"]).toEqual(expect.any(String));
    expect((await trace(web.port, "/api/v1/inbox")).headers["vary"]).toBeUndefined();

    expect(web.output()).not.toContain("as Next.js does");
  });
});

describe("the web role's log", STARTS_THE_ROLE, () => {
  it("is only JSON lines on standard output, with what the server prints to the console redacted like any line", async () => {
    const web = await startWebRole();
    const canary = `canary-${randomBytes(8).toString("hex")}`;
    const failed = await fetch(`http://127.0.0.1:${web.port}/fail/${canary}?token=th_pat_${canary}`);
    expect(failed.status).toBe(500);
    await until("the server to print its error", () => web.output().includes('"msg":"⨯"'));
    web.child.kill("SIGTERM");
    expect(await web.exited).toBe(0);

    const lines = web.stdout().split("\n").filter((line) => line !== "");
    for (const line of lines) expect(() => JSON.parse(line) as unknown, line).not.toThrow();
    const entries = logEntries(web.stdout());
    expect(entries.length).toBe(lines.length);
    expect(entries.slice(0, 4)).toEqual([
      expect.objectContaining({ level: "info", msg: "▲ Next.js 16.3.5", role: "web", via: "console" }),
      expect.objectContaining({ level: "info", msg: `- Local: http://localhost:${web.port}`, role: "web", via: "console" }),
      expect.objectContaining({ level: "info", msg: "✓ Ready in 0ms", role: "web", via: "console" }),
      expect.objectContaining({ level: "info", msg: "fixture: listening", role: "web", via: "console" }),
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({ level: "error", msg: "⨯", via: "console", error: expect.objectContaining({ name: "Error" }) }),
    );
    expect(web.output()).not.toContain(canary);
  });
});

// public-api: Request bodies have a size limit; public-api: One error model for Tiehall's own refusals. The web
// role's request guard sees every request before the app does, so a body over 2 MiB is answered 413, as an RFC
// 9457 problem whose detail names the limit, before any route, the setup gate or a token check can answer it: a
// declared length above the limit at once, and a body sent in chunks at the byte past the limit. The answer
// carries `Connection: close`, and the rest of the body is not read. The fixture stands in for the app's routes:
// /api/v1/… answers as the setup gate does before setup is complete, /mcp answers 200 as an MCP server does, and
// /setup reads the form posted to it.
describe("the web role's limit on request bodies", STARTS_THE_ROLE, () => {
  const MiB = 1024 * 1024;
  const LIMIT = 2 * MiB;
  const PAYLOAD_TOO_LARGE = "https://tiehall.com/problems/payload-too-large";

  interface Answer {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }

  /** Collects an answer's status, headers and body. */
  function collect(response: http.IncomingMessage): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      response.on("error", reject);
    });
  }

  /** The problem of a 413 answer, after checking that it is the error model's answer to a body over the limit. */
  function expectPayloadTooLarge(answer: Answer): void {
    expect(answer.status).toBe(413);
    expect(answer.headers["content-type"]).toBe("application/problem+json");
    expect(answer.headers["connection"]).toBe("close");
    expect(answer.headers["retry-after"]).toBeUndefined();
    expect(JSON.parse(answer.body)).toMatchObject({ type: PAYLOAD_TOO_LARGE, status: 413, detail: expect.stringContaining("2 MiB") });
  }

  it("answers a request that declares a body above 2 MiB with 413 before any byte of the body is sent", async () => {
    const web = await startWebRole();
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path: "/api/v1/requests",
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(3 * MiB) },
    });
    try {
      const answered = new Promise<Answer>((resolve, reject) => {
        request.on("response", (response) => void collect(response).then(resolve, reject));
        request.on("error", reject);
      });
      // Only the request line and the headers leave: the body is never written.
      request.flushHeaders();
      expectPayloadTooLarge(await answered);
    } finally {
      request.destroy();
    }
  });

  it("answers a body sent in chunks with 413 at the byte past 2 MiB, before the client has finished, and reads no further", async () => {
    const web = await startWebRole({ LOG_CONNECTIONS: "on" });
    const planned = 32 * MiB;
    const chunk = Buffer.alloc(64 * 1024, " ");
    let written = 0;
    // No content-length: the body goes in chunks, with no declared length.
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path: "/api/v1/requests",
      agent: false,
      headers: { "content-type": "application/json" },
    });
    let answer: Answer & { writtenBefore: number };
    try {
      answer = await new Promise((resolve, reject) => {
        let answered = false;
        request.on("response", (response) => {
          answered = true;
          const writtenBefore = written;
          void collect(response).then((collected) => resolve({ ...collected, writtenBefore }), reject);
        });
        request.on("error", (error) => {
          if (!answered) reject(error);
        });
        const send = (): void => {
          while (!answered && written < planned) {
            written += chunk.length;
            if (!request.write(chunk)) {
              request.once("drain", send);
              return;
            }
          }
          if (!answered) request.end();
        };
        send();
      });
    } finally {
      request.destroy();
    }
    expectPayloadTooLarge(answer);
    expect(answer.writtenBefore).toBeGreaterThan(LIMIT);
    expect(answer.writtenBefore).toBeLessThan(planned);
    // The app got none of the body, and the connection read no more than the one socket read, of at most 64 KiB,
    // that held the byte past the limit, besides the request's head and the chunks' framing.
    const closed = /^fixture: a connection closed after reading (\d+) bytes$/;
    await until("the connection to close", () => logEntries(web.stdout()).some(({ msg }) => closed.test(String(msg))));
    const bytesRead = Number(closed.exec(String(logEntries(web.stdout()).find(({ msg }) => closed.test(String(msg)))?.["msg"]))?.[1]);
    expect(bytesRead).toBeGreaterThan(LIMIT);
    expect(bytesRead).toBeLessThanOrEqual(LIMIT + 128 * 1024);
    expect(web.output()).not.toContain("fixture: /api/v1/requests");
  });

  it("passes a body sent in chunks on whole once it is complete, when it is no larger than 2 MiB", async () => {
    const web = await startWebRole();
    const request = http.request({ host: "127.0.0.1", port: web.port, method: "POST", path: "/mcp", agent: false });
    try {
      const answered = new Promise<Answer>((resolve, reject) => {
        request.on("response", (response) => void collect(response).then(resolve, reject));
        request.on("error", reject);
      });
      const chunk = Buffer.alloc(64 * 1024, " ");
      for (let sent = 0; sent < LIMIT; sent += chunk.length) request.write(chunk);
      request.end();
      const answer = await answered;
      expect(answer.status).toBe(200);
      expect(web.output()).toContain(`fixture: /mcp read ${LIMIT} bytes`);
    } finally {
      request.destroy();
    }
  });

  it("answers a body over 2 MiB with 413 while the role shuts down, before the 503 every other new call gets", async () => {
    const web = await startWebRole();
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).then((response) => response.text());
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));
    web.child.kill("SIGTERM");
    await until("the role to start stopping", () => web.output().includes("web: stopping"));
    const over = await fetch(`http://127.0.0.1:${web.port}/api/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: " ".repeat(LIMIT + 1),
    });
    expectPayloadTooLarge({ status: over.status, headers: Object.fromEntries(over.headers), body: await over.text() });
    const within = await fetch(`http://127.0.0.1:${web.port}/api/v1/requests`, { method: "POST", body: "{}" });
    expect(within.status).toBe(503);
    expect(await slow).toBe("slow call done");
    expect(await web.exited).toBe(0);
  });

  // self-host-install: A restart stops the app gracefully. A new call whose request declares a length within its
  // limit gets the shutdown's 503 at once, before any byte of its body is read or held: no byte of it could change
  // that answer, and holding it until its body arrived would keep the shutdown waiting for a client that may never
  // send it, and end with its connection closed rather than answered.
  it("answers a new call that declares a body within its limit with 503 at once while the role shuts down, before any byte of the body is sent", async () => {
    const web = await startWebRole({ SLOW_MS: "3000", DRAIN_TIMEOUT_MS: "8000" });
    let slowDone = false;
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).then(async (response) => {
      const text = await response.text();
      slowDone = true;
      return text;
    });
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));
    web.child.kill("SIGTERM");
    await until("the role to start stopping", () => web.output().includes("web: stopping"));
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path: "/api/v1/requests",
      agent: false,
      headers: { "content-type": "application/json", "content-length": "100" },
    });
    try {
      const answered = new Promise<Answer>((resolve, reject) => {
        request.on("response", (response) => void collect(response).then(resolve, reject));
        request.on("error", reject);
      });
      // Only the request line and the headers leave: the body is never written.
      request.flushHeaders();
      const answer = await answered;
      // The answer came while the call in flight still ran.
      expect(slowDone).toBe(false);
      expect(answer.status).toBe(503);
      expect(answer.headers["retry-after"]).toBe("0");
      expect(answer.headers["content-type"]).toBe("application/problem+json");
      expect(JSON.parse(answer.body)).toMatchObject({ type: "https://tiehall.com/problems/shutting-down", status: 503 });
    } finally {
      request.destroy();
    }
    expect(await slow).toBe("slow call done");
    expect(await web.exited).toBe(0);
    // The role stopped once the call in flight had finished, and cut no call off.
    expect(logEntries(web.output()).map(({ msg }) => msg)).toContain("web: stopped");
    expect(web.output()).not.toContain("fixture: /api/v1/requests");
  });

  // self-host-install: A restart stops the app gracefully. The guard holds a body sent in chunks until it is
  // complete, so the call counts as in flight from the moment its head arrives: a shutdown waits for its body as
  // for any call in flight, and never closes its connection while the body is still arriving.

  /** A POST to this path whose body goes in chunks, and the answer it gets; it rejects if the connection fails. */
  function chunkedPost(port: number, path: string): { request: http.ClientRequest; answered: Promise<Answer> } {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path, agent: false, headers: { "content-type": "application/json" } });
    const answered = new Promise<Answer>((resolve, reject) => {
      request.on("response", (response) => void collect(response).then(resolve, reject));
      request.on("error", reject);
    });
    // Handled where the test awaits it; this only keeps an early failure from counting as unhandled.
    answered.catch(() => undefined);
    return { request, answered };
  }

  it("lets a call whose body is still arriving in chunks when the role stops finish, as a call in flight", async () => {
    const web = await startWebRole({ LOG_HEADS: "on" });
    const { request, answered } = chunkedPost(web.port, "/mcp");
    const chunk = Buffer.alloc(64 * 1024, " ");
    try {
      request.write(chunk);
      await until("the server to have the call's head", () => web.output().includes("fixture: the server has the head of POST /mcp"));
      web.child.kill("SIGTERM");
      await until("the role to start stopping", () => web.output().includes("web: stopping"));
      for (let sent = chunk.length; sent < MiB; sent += chunk.length) request.write(chunk);
      request.end();
      const answer = await answered;
      expect(answer.status).toBe(200);
    } finally {
      request.destroy();
    }
    expect(web.output()).toContain(`fixture: /mcp read ${MiB} bytes`);
    expect(await web.exited).toBe(0);
    expect(logEntries(web.output()).map(({ msg }) => msg)).toEqual(
      expect.arrayContaining(["web: stopping; new calls get 503 until the 1 call in flight finishes", "web: stopped"]),
    );
  });

  it("answers a new call whose body is still arriving when the calls in flight finish with 503, once its body is complete", async () => {
    // The slow call stays in flight well past the time the new call takes to reach the server.
    const web = await startWebRole({ LOG_HEADS: "on", SLOW_MS: "3000" });
    const slow = fetch(`http://127.0.0.1:${web.port}/slow`).then((response) => response.text());
    await until("the slow call to start", () => web.output().includes("fixture: slow call started"));
    web.child.kill("SIGTERM");
    await until("the role to start stopping", () => web.output().includes("web: stopping"));
    const { request, answered } = chunkedPost(web.port, "/api/v1/requests");
    try {
      request.write('{"title":');
      await until("the server to have the new call's head", () => web.output().includes("fixture: the server has the head of POST /api/v1/requests"));
      // The call in flight finishes while the new call's body is still arriving.
      expect(await slow).toBe("slow call done");
      request.end('"Add a dark mode"}');
      const answer = await answered;
      expect(answer.status).toBe(503);
      expect(answer.headers["retry-after"]).toBe("0");
      expect(answer.headers["content-type"]).toBe("application/problem+json");
      expect(JSON.parse(answer.body)).toMatchObject({ type: "https://tiehall.com/problems/shutting-down", status: 503 });
    } finally {
      request.destroy();
    }
    expect(web.output()).not.toContain("fixture: /api/v1/requests answered");
    expect(await web.exited).toBe(0);
  });

  it("answers a body over 2 MiB to /mcp with the HTTP status 413, not with a tool result in a 200", async () => {
    const web = await startWebRole();
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_request", arguments: { title: "x".repeat(3 * MiB) } } };
    const response = await fetch(`http://127.0.0.1:${web.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(call),
    });
    expectPayloadTooLarge({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    expect(web.output()).not.toContain("fixture: /mcp");
  });

  it("answers a body over 2 MiB with 413 before setup is complete and without a token, not with 503 or 401", async () => {
    const web = await startWebRole();
    const response = await fetch(`http://127.0.0.1:${web.port}/api/v1/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Add a dark mode", padding: " ".repeat(3 * MiB) }),
    });
    expectPayloadTooLarge({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    expect(web.output()).not.toContain("fixture: /api/v1/requests");
  });

  // GitHub caps a webhook delivery at 25 MB, so /webhooks/github takes up to 25 MiB, and no more.
  it("passes a GitHub delivery over 2 MiB on to /webhooks/github, and answers one that declares more than 25 MiB with 413 before its body is sent", async () => {
    const web = await startWebRole();
    const delivery = await fetch(`http://127.0.0.1:${web.port}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "synchronize", padding: " ".repeat(3 * MiB) }),
    });
    expect(delivery.status).toBe(200);
    expect(await delivery.text()).toMatch(/^delivery of \d+ bytes$/);

    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path: "/webhooks/github",
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(25 * MiB + 1) },
    });
    try {
      const answered = new Promise<Answer>((resolve, reject) => {
        request.on("response", (response) => void collect(response).then(resolve, reject));
        request.on("error", reject);
      });
      request.flushHeaders();
      const answer = await answered;
      expect(answer.status).toBe(413);
      expect(answer.headers["connection"]).toBe("close");
      expect(JSON.parse(answer.body)).toMatchObject({ type: PAYLOAD_TOO_LARGE, status: 413, detail: expect.stringContaining("25 MiB") });
    } finally {
      request.destroy();
    }
    expect(web.output()).not.toContain(`fixture: /webhooks/github read ${25 * MiB + 1} bytes`);
  });

  it("passes a form of the web UI of up to 2 MiB on to its page, and answers one byte more with 413", async () => {
    const web = await startWebRole();
    const post = (bytes: number) =>
      fetch(`http://127.0.0.1:${web.port}/setup`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `code=${"A".repeat(bytes - "code=".length)}`,
      });
    for (const bytes of [LIMIT - 1, LIMIT]) {
      const response = await post(bytes);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`form of ${bytes} bytes`);
    }
    const over = await post(LIMIT + 1);
    expectPayloadTooLarge({ status: over.status, headers: Object.fromEntries(over.headers), body: await over.text() });
    expect(web.output()).not.toContain(`fixture: /setup read ${LIMIT + 1} bytes`);
  });

  // public-api: One error model for Tiehall's own refusals (github-layer-hardening: design.md, Decisions this
  // change rests on: D50 (7)): a browser whose form on one of the web UI's pages is over the limit gets the 413 as a
  // page that leads back to the page whose form was refused; a client that asks for JSON there, and every call to
  // the REST API whatever it accepts, gets the problem.
  it("answers a browser's form over 2 MiB on a page with 413 as a page that leads back to the page, and every other call with the problem", async () => {
    const web = await startWebRole();
    const post = (path: string, accept: string) =>
      fetch(`http://127.0.0.1:${web.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept },
        body: `action=create&login=${"A".repeat(LIMIT)}`,
      });

    const page = await post("/admin/invites", BROWSER);
    expect(page.status).toBe(413);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("connection")).toBe("close");
    expect(page.headers.get("retry-after")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const markup = await page.text();
    expect(markup).toContain("<h1>Request body too large</h1>");
    expect(markup).toContain("larger than 2 MiB");
    expect(markup).toContain(`<code>${PAYLOAD_TOO_LARGE}</code>`);
    expect(markup).toContain('<a class="button" href="/admin/invites">');
    expect(markup).not.toContain("<script");

    for (const [path, accept] of [
      ["/admin/invites", "application/json"],
      ["/api/v1/requests", BROWSER],
    ] as const) {
      const answer = await post(path, accept);
      expectPayloadTooLarge({ status: answer.status, headers: Object.fromEntries(answer.headers), body: await answer.text() });
    }
  });

  // public-api: Request bodies have a size limit, its scenario "A web form over the limit"
  // (decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (2)): the same form of the web UI,
  // sent over the limit by a client whose Accept header asks for JSON, gets the problem and not the page, and
  // changes nothing: the page's route, which reads a form within the limit, never sees it.
  it("answers the same form sent with Accept: application/json with the problem payload-too-large, and its route never sees it", async () => {
    const web = await startWebRole();
    const post = (bytes: number) =>
      fetch(`http://127.0.0.1:${web.port}/admin/invites`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: `action=create&login=${"A".repeat(bytes - "action=create&login=".length)}`,
      });

    const within = await post(LIMIT);
    expect(within.status).toBe(200);
    expect(await within.text()).toBe(`form of ${LIMIT} bytes`);

    const over = await post(LIMIT + 1);
    expectPayloadTooLarge({ status: over.status, headers: Object.fromEntries(over.headers), body: await over.text() });
    expect(web.output()).toContain(`fixture: /admin/invites read ${LIMIT} bytes`);
    expect(web.output()).not.toContain(`fixture: /admin/invites read ${LIMIT + 1} bytes`);
  });

  // A review page's form posts to /confirm/<command> without the review page's query, which holds its input, so the
  // page leads back to the page the browser posted the form from, as its Referer names it on the install: on
  // TIEHALL_URL's origin, whatever Host header a proxy in front of the install sends the app. A Referer on any other
  // origin, the Host header's own included, leads to the form's own target.
  it("leads a browser's review page form over 2 MiB back to the review page, with its input, as its Referer names it on TIEHALL_URL", async () => {
    const web = await startWebRole();
    const review = "/confirm/members.change_role?input=%7B%22role%22%3A%22admin%22%7D";
    // The role's TIEHALL_URL is http://localhost:3000; the calls reach it at 127.0.0.1 and its port, as through a proxy that rewrites Host.
    const post = (referer: string) =>
      fetch(`http://127.0.0.1:${web.port}/confirm/members.change_role`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: BROWSER, referer },
        body: `confirmation=${"A".repeat(LIMIT)}`,
      });

    const page = await post(`http://localhost:3000${review}`);
    expect(page.status).toBe(413);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain(`<a class="button" href="${review}">`);

    for (const referer of [`https://elsewhere.example${review}`, `http://127.0.0.1:${web.port}${review}`]) {
      const elsewhere = await post(referer);
      expect(elsewhere.status).toBe(413);
      expect(await elsewhere.text()).toContain('<a class="button" href="/confirm/members.change_role">');
    }
  });
});

// public-api: Request bodies have a size limit (decisions-from-groups-15-28: design.md, Decisions this change rests on:
// D55 (5); Technical decisions: T1). Besides each body's own limit, one web process holds at most 64 MiB of request
// bodies being received at once. A body holds the bytes of it that have arrived, whether its request declares its
// length or sends it in chunks, so a request that declares a length and sends nothing holds none of the cap. A body
// whose bytes would take the bytes being received past the cap as they arrive is answered at once with 503 busy and
// Retry-After, is read no further, and the app never sees it; a body over its own limit still gets 413 first; and the
// bytes of a body are released once it has been read, refused or abandoned (request-guard.test.ts tests each way a
// body ends, the server's request timeout included).
describe("the web role's cap on bodies being received at once", STARTS_THE_ROLE, () => {
  const MiB = 1024 * 1024;
  const BUSY = "https://tiehall.com/problems/busy";

  interface Answer {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
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

  /** The answer of a 503 for the cap, after checking that it is the error model's busy. */
  function expectBusy(answer: Answer): void {
    expect(answer.status).toBe(503);
    expect(answer.headers["content-type"]).toBe("application/problem+json");
    expect(answer.headers["retry-after"]).toBe("5");
    expect(answer.headers["connection"]).toBe("close");
    expect(JSON.parse(answer.body)).toMatchObject({ type: BUSY, title: "Too busy", status: 503, retryAfter: 5 });
  }

  /** How many calls of this method and path the server has the head of, as LOG_HEADS=on prints them. */
  function heads(web: Running, call: string): number {
    return logEntries(web.output()).filter(({ msg }) => msg === `fixture: the server has the head of ${call}`).length;
  }

  /**
   * How many bytes of request bodies the role's request guard holds now, as the fixture's probe reads them, over a
   * connection of its own that closes after the answer.
   */
  async function held(web: Running): Promise<number> {
    const answer = await new Promise<Answer>((resolve, reject) => {
      const probe = http.get({ host: "127.0.0.1", port: web.port, path: "/bodies-in-flight", agent: false }, (response) => void collect(response).then(resolve, reject));
      probe.on("error", reject);
    });
    return Number(answer.body);
  }

  /** Waits until the request guard holds at least this many bytes of request bodies. */
  async function untilHeld(web: Running, bytes: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    while ((await held(web)) < bytes) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the guard to hold ${bytes} bytes`);
      await sleep(20);
    }
  }

  /**
   * Starts a POST that declares a body of this many bytes, sends all of it but its last KiB, or as many bytes as
   * given, and holds the rest back, as a slow client does; it waits until the server has the call's head and the
   * guard holds the bytes sent.
   */
  async function holdOpen(web: Running, path: string, bytes: number, sent = bytes - 1024): Promise<http.ClientRequest> {
    const before = heads(web, `POST ${path}`);
    const bytesBefore = await held(web);
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path,
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(bytes) },
    });
    request.on("error", () => {});
    if (sent === 0) request.flushHeaders();
    else request.write(Buffer.alloc(sent, " "));
    await until(`the server to have the head of POST ${path}`, () => heads(web, `POST ${path}`) > before);
    await untilHeld(web, bytesBefore + sent);
    return request;
  }

  /** Sends only the head of a POST that declares a body of this many bytes, and returns the answer it gets. */
  async function declare(web: Running, path: string, bytes: number, headers: Record<string, string> = {}): Promise<Answer> {
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path,
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(bytes), ...headers },
    });
    try {
      const answered = new Promise<Answer>((resolve, reject) => {
        request.on("response", (response) => void collect(response).then(resolve, reject));
        request.on("error", reject);
      });
      // Only the request line and the headers leave: the body is never written.
      request.flushHeaders();
      return await answered;
    } finally {
      request.destroy();
    }
  }

  /**
   * Sends a POST that declares a body of this many bytes, and the body in 64 KiB pieces until it is all sent or the
   * call is answered; returns the answer, with how many bytes had been written when it came.
   */
  async function send(web: Running, path: string, bytes: number, headers: Record<string, string> = {}): Promise<Answer & { writtenBefore: number }> {
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path,
      agent: false,
      headers: { "content-type": "application/json", "content-length": String(bytes), ...headers },
    });
    const piece = Buffer.alloc(64 * 1024, " ");
    let written = 0;
    try {
      return await new Promise((resolve, reject) => {
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
    } finally {
      request.destroy();
    }
  }

  /** Ends the held calls as clients that give up do, and waits until the server has closed their connections. */
  async function abandon(web: Running, held: http.ClientRequest[]): Promise<void> {
    const closed = (): number => web.stdout().split("fixture: a connection closed after reading").length - 1;
    const before = closed();
    for (const request of held) request.destroy();
    await until("the held connections to close", () => closed() >= before + held.length);
  }

  it("answers a declared body with 503 busy at the bytes that take the bodies received past 64 MiB, and not once the others end", async () => {
    const web = await startWebRole({ LOG_HEADS: "on", LOG_CONNECTIONS: "on" });
    const held = [await holdOpen(web, "/webhooks/github", 25 * MiB), await holdOpen(web, "/webhooks/github", 25 * MiB)];
    try {
      const busy = await send(web, "/api/v1/contract-reports", 15 * MiB);
      expectBusy(busy);
      // 50 MiB less 2 KiB have arrived of the two deliveries, so the report passes the 64 MiB a little after its 14th
      // MiB has arrived, and not when its head does. The app got none of it, and the refused connection, the first to
      // close, read no more than the one socket read, of at most 64 KiB, that held the bytes past the cap, besides the
      // request's head.
      expect(busy.writtenBefore).toBeGreaterThan(14 * MiB);
      const closed = /^fixture: a connection closed after reading (\d+) bytes$/;
      await until("the refused connection to close", () => logEntries(web.stdout()).some(({ msg }) => closed.test(String(msg))));
      const bytesRead = Number(closed.exec(String(logEntries(web.stdout()).find(({ msg }) => closed.test(String(msg)))?.["msg"]))?.[1]);
      expect(bytesRead).toBeGreaterThan(14 * MiB);
      expect(bytesRead).toBeLessThanOrEqual(14 * MiB + 128 * 1024);
      expect(web.output()).not.toContain("fixture: /api/v1/contract-reports");

      await abandon(web, held);
      const after = await send(web, "/api/v1/contract-reports", 15 * MiB);
      // The call reaches the app, which answers it as the setup gate does before setup is complete.
      expect(after.status).toBe(503);
      expect(JSON.parse(after.body)).toMatchObject({ type: "https://tiehall.com/problems/setup-required" });
      expect(web.output()).toContain("fixture: /api/v1/contract-reports answered 503 without reading the body");
    } finally {
      for (const request of held) request.destroy();
    }
  });

  // decisions-from-groups-15-28: the maintainer's answer of 2026-10-12 to the open question "Bodies declared and not
  // sent": a declared length is not reserved when the head arrives, so connections that declare bodies and send
  // nothing hold none of the cap, however large the bodies they declare.
  it("lets requests that declare 25, 25 and 14 MiB to /webhooks/github and send nothing hold none of the cap, so a delivery is not refused", async () => {
    const web = await startWebRole({ LOG_HEADS: "on" });
    const held = [
      await holdOpen(web, "/webhooks/github", 25 * MiB, 0),
      await holdOpen(web, "/webhooks/github", 25 * MiB, 0),
      await holdOpen(web, "/webhooks/github", 14 * MiB, 0),
    ];
    try {
      const delivery = await send(web, "/webhooks/github", 25 * MiB);
      expect(delivery.status).toBe(200);
      expect(delivery.body).toBe(`delivery of ${25 * MiB} bytes`);
    } finally {
      for (const request of held) request.destroy();
    }
  });

  it("answers a body sent in chunks with 503 busy at the byte past the cap, before the client has finished, and reads no further", async () => {
    const web = await startWebRole({ LOG_HEADS: "on", LOG_CONNECTIONS: "on" });
    const held = [await holdOpen(web, "/webhooks/github", 25 * MiB), await holdOpen(web, "/webhooks/github", 25 * MiB)];
    const planned = 32 * MiB;
    const chunk = Buffer.alloc(64 * 1024, " ");
    let written = 0;
    // No content-length: the body goes in chunks, with no declared length, to contract.report, whose own limit is 16 MiB;
    // the client means to send twice that, and the cap stops it first.
    const request = http.request({
      host: "127.0.0.1",
      port: web.port,
      method: "POST",
      path: "/api/v1/contract-reports",
      agent: false,
      headers: { "content-type": "application/json" },
    });
    let answer: Answer & { writtenBefore: number };
    try {
      answer = await new Promise((resolve, reject) => {
        let answered = false;
        request.on("response", (response) => {
          answered = true;
          const writtenBefore = written;
          void collect(response).then((collected) => resolve({ ...collected, writtenBefore }), reject);
        });
        request.on("error", (error) => {
          if (!answered) reject(error);
        });
        const next = (): void => {
          while (!answered && written < planned) {
            written += chunk.length;
            if (!request.write(chunk)) {
              request.once("drain", next);
              return;
            }
          }
          if (!answered) request.end();
        };
        next();
      });
    } finally {
      request.destroy();
    }
    expectBusy(answer);
    // 50 MiB less 2 KiB are held, so the body passes the 64 MiB at its 14th MiB, before the 16 MiB of its own limit.
    expect(answer.writtenBefore).toBeGreaterThan(14 * MiB);
    expect(answer.writtenBefore).toBeLessThan(planned);
    // The app got none of the body, and the refused connection, the first to close, read no more than the one socket
    // read, of at most 64 KiB, that held the byte past the cap, besides the request's head and the chunks' framing.
    const closed = /^fixture: a connection closed after reading (\d+) bytes$/;
    await until("the refused connection to close", () => logEntries(web.stdout()).some(({ msg }) => closed.test(String(msg))));
    const bytesRead = Number(closed.exec(String(logEntries(web.stdout()).find(({ msg }) => closed.test(String(msg)))?.["msg"]))?.[1]);
    expect(bytesRead).toBeGreaterThan(14 * MiB);
    expect(bytesRead).toBeLessThanOrEqual(14 * MiB + 128 * 1024);
    expect(web.output()).not.toContain("fixture: /api/v1/contract-reports");
    for (const holder of held) holder.destroy();
  });

  it("answers a body over its own limit with 413 and not 503, whatever the bodies being received hold", async () => {
    const web = await startWebRole({ LOG_HEADS: "on" });
    const held = [
      await holdOpen(web, "/webhooks/github", 25 * MiB),
      await holdOpen(web, "/webhooks/github", 25 * MiB),
      await holdOpen(web, "/webhooks/github", 10 * MiB),
    ];
    try {
      const answer = await declare(web, "/api/v1/requests", 3 * MiB);
      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body)).toMatchObject({ type: "https://tiehall.com/problems/payload-too-large", status: 413 });
      // 60 MiB less 3 KiB are held, so a body of 4 MiB fits, and is passed on.
      const within = await send(web, "/api/v1/contract-reports", 4 * MiB);
      expect(JSON.parse(within.body)).toMatchObject({ type: "https://tiehall.com/problems/setup-required" });
    } finally {
      for (const request of held) request.destroy();
    }
  });

  it("answers /mcp with the HTTP status 503 busy, not with a tool result in a 200, and a browser's form with the refusal as a page", async () => {
    const web = await startWebRole({ LOG_HEADS: "on" });
    const held = [
      await holdOpen(web, "/webhooks/github", 25 * MiB),
      await holdOpen(web, "/webhooks/github", 25 * MiB),
      await holdOpen(web, "/webhooks/github", 13 * MiB),
    ];
    try {
      expectBusy(await send(web, "/mcp", 2 * MiB, { accept: "application/json, text/event-stream" }));
      expect(web.output()).not.toContain("fixture: /mcp");

      const page = await send(web, "/admin/invites", 2 * MiB, { "content-type": "application/x-www-form-urlencoded", accept: BROWSER });
      expect(page.status).toBe(503);
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(page.headers["retry-after"]).toBe("5");
      expect(page.body).toContain("<h1>Too busy</h1>");
      expect(page.body).toContain(`<code>${BUSY}</code>`);
      expect(page.body).toContain('<a class="button" href="/admin/invites">');
      expect(web.output()).not.toContain("fixture: /admin/invites");
    } finally {
      for (const request of held) request.destroy();
    }
  });
});

// self-host-install: The setup code guards the setup screen. While setup is incomplete, each start prints a new
// setup code to the log, where `docker compose logs app` shows it, and stores only its hash, which replaces the
// previous one.
describe("the web role at start", STARTS_THE_ROLE, () => {
  const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
  const appRole = { name: `tiehall_app_${randomBytes(4).toString("hex")}`, password: randomBytes(16).toString("hex") };
  let database: TestDatabase;
  let owner: pg.Client;
  let appDatabase: Record<string, string>;

  beforeAll(async () => {
    database = await createTestDatabase();
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    await migrate({ connectionString: database.url }, { migrationsFolder, release: "0.0.0-dev", appRole, log: () => {} });
    const url = new URL(database.url);
    url.username = appRole.name;
    url.password = "";
    appDatabase = { TIEHALL_DATABASE_APP_URL: url.toString(), TIEHALL_DATABASE_APP_PASSWORD: appRole.password, WITH_SETUP: "on" };
  });

  afterAll(async () => {
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(appRole.name)}; DROP ROLE ${pg.escapeIdentifier(appRole.name)}`);
    await owner.end();
    await database.drop();
  });

  const CODE_LINE = /^setup: setup is not complete\. Open http:\/\/localhost:3000\/setup and enter the setup code ([0-9A-Z-]+)$/;

  /** Starts the role, waits for the setup code it prints, stops it, and returns the code. */
  async function codeOfOneStart(): Promise<string> {
    const web = await startWebRole(appDatabase);
    await until("the setup code", () => logEntries(web.stdout()).some(({ msg }) => CODE_LINE.test(String(msg))));
    web.child.kill("SIGTERM");
    expect(await web.exited).toBe(0);
    const line = logEntries(web.stdout()).find(({ msg }) => CODE_LINE.test(String(msg)));
    expect(line).toMatchObject({ level: "info", role: "web" });
    return CODE_LINE.exec(String(line?.["msg"]))?.[1] ?? "";
  }

  it("prints a new setup code each time while setup is incomplete, and stores only the hash of the latest", async () => {
    const first = await codeOfOneStart();
    const second = await codeOfOneStart();
    expect(first).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
    expect(second).not.toBe(first);
    const hash = createHash("sha256").update(second.replaceAll("-", "")).digest();
    expect((await owner.query("SELECT code_hash FROM setup_codes")).rows).toEqual([{ code_hash: hash }]);
  });

  it("prints no setup code once setup is complete", async () => {
    await owner.query("UPDATE orgs SET name = 'Acme', setup_completed_at = now()");
    try {
      const web = await startWebRole(appDatabase);
      // The step reads the database beside the server's start, well within this wait.
      await sleep(1_500);
      web.child.kill("SIGTERM");
      expect(await web.exited).toBe(0);
      expect(web.output()).not.toContain("setup code");
    } finally {
      await owner.query("UPDATE orgs SET setup_completed_at = NULL");
    }
  });

  it("serves while the database cannot be reached, and logs that the setup code is not printed yet", async () => {
    const web = await startWebRole({ ...appDatabase, TIEHALL_DATABASE_APP_URL: "postgres://tiehall_app@127.0.0.1:1/tiehall" });
    await until("the role to say why", () => web.output().includes("web: the setup code could not be printed"));
    expect(logEntries(web.stdout())).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "web: the setup code could not be printed; trying again in 5 seconds" }),
    );
    expect(await (await fetch(`http://127.0.0.1:${web.port}/`)).text()).toBe("ok");
  });
});
