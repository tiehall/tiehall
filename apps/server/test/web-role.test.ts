import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
