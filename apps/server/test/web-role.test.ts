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

async function until(what: string, check: () => boolean, seconds = 20): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

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

describe("the web role on SIGTERM", () => {
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
      expect(markup, path).toContain(`<a href="${wayOn}">`);
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
      expect(await page.text(), accept).toContain('<a href="/FE-142">');
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
describe("the web role's answers of request URLs", () => {
  it("name Accept and Authorization in their Vary, besides what the page set, and leave other answers as they are", async () => {
    const web = await startWebRole();
    const vary = async (path: string) => (await fetch(`http://127.0.0.1:${web.port}${path}`)).headers.get("vary");
    expect(await vary("/FE-142")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(await vary("/FE-142.md")).toBe("rsc, next-router-state-tree, Accept, Authorization");
    expect(await vary("/members/page")).toBe("rsc, next-router-state-tree");
  });
});

describe("the web role's log", () => {
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
describe("the web role's limit on request bodies", () => {
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
    expect(markup).toContain('<a href="/admin/invites">');
    expect(markup).not.toContain("<script");

    for (const [path, accept] of [
      ["/admin/invites", "application/json"],
      ["/api/v1/requests", BROWSER],
    ] as const) {
      const answer = await post(path, accept);
      expectPayloadTooLarge({ status: answer.status, headers: Object.fromEntries(answer.headers), body: await answer.text() });
    }
  });

  // A review page's form posts to /confirm/<command> without the review page's query, which holds its input, so the
  // page leads back to the page the browser posted the form from, as its Referer names it on the install; a Referer
  // on another host leads to the form's own target.
  it("leads a browser's review page form over 2 MiB back to the review page, with its input, as its Referer names it", async () => {
    const web = await startWebRole();
    const review = "/confirm/members.change_role?input=%7B%22role%22%3A%22admin%22%7D";
    const post = (referer: string) =>
      fetch(`http://127.0.0.1:${web.port}/confirm/members.change_role`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: BROWSER, referer },
        body: `confirmation=${"A".repeat(LIMIT)}`,
      });

    const page = await post(`http://127.0.0.1:${web.port}${review}`);
    expect(page.status).toBe(413);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain(`<a href="${review}">`);

    const elsewhere = await post(`https://elsewhere.example${review}`);
    expect(elsewhere.status).toBe(413);
    expect(await elsewhere.text()).toContain('<a href="/confirm/members.change_role">');
  });
});

// self-host-install: The setup code guards the setup screen. While setup is incomplete, each start prints a new
// setup code to the log, where `docker compose logs app` shows it, and stores only its hash, which replaces the
// previous one.
describe("the web role at start", () => {
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
