import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The web role stops gracefully (self-host-install: A restart stops the app
// gracefully; public-api: One error model for Tiehall's own refusals). Docker
// sends SIGTERM when Compose stops or replaces the app container. From then
// on, every new call is answered 503 with `Retry-After: 0`, as an RFC 9457
// problem, so clients retry once the app is back; the calls already in flight
// finish; then the role exits 0. The worker's side, where a job interrupted by
// the stop runs again after the restart, is tested in worker-role.test.ts.

const fixture = fileURLToPath(new URL("./support/web-with-fixture-server.ts", import.meta.url));

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
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
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  running = { child, port, output: () => output, exited };
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
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      detail: "Tiehall is shutting down. Retry the call; it is answered once Tiehall is back.",
    });

    expect(await slow).toEqual({ status: 200, body: "slow call done" });
    expect(await web.exited).toBe(0);
    expect(logEntries(web.output()).map(({ msg }) => msg)).toEqual([
      "web: stopping; new calls get 503 until the 1 call in flight finishes",
      "web: stopped",
    ]);
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
