import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";
import type { TestInstall } from "./install.ts";

// The web app as the image runs it, for the tests of what only the running
// Next.js app does: the proxy that runs before every route (apps/web/proxy.ts),
// server components and server actions (design.md, Technical decisions: T1 and
// T3). The app in apps/web is built with `next build`, once per run of this
// project between the test files that start it (web-app-run.ts), and its
// standalone server is started as its own process, as the web role starts it
// as far as a request URL's answers go (web-app-server.ts), with the settings of a test
// install: its database, as the app role, its keys and a trial URL,
// http://localhost and a free port, where it listens on 127.0.0.1. A browser
// reaches it at that URL through a host-resolver rule; a test's own calls go
// to 127.0.0.1 and the port.

/** The web app, apps/web. */
const WEB = fileURLToPath(new URL("../../../../apps/web/", import.meta.url));
const NEXT_BIN = createRequire(join(WEB, "package.json")).resolve("next/dist/bin/next");
/** The standalone server `next build` writes, as the image copies it. */
const STANDALONE = join(WEB, ".next", "standalone", "apps", "web");
/** Starts the standalone server as the web role does, as far as a request URL's answers go (web-app-server.ts). */
const LAUNCHER = fileURLToPath(new URL("./web-app-server.ts", import.meta.url));
/** The file that names the run whose build .next holds. */
const BUILT_FOR = join(WEB, ".next", "tiehall-test-run");
/** Held while one test file builds the app, so no other builds it at once; one per checkout. */
const BUILD_LOCK = join(tmpdir(), `tiehall-web-app-build-${createHash("sha256").update(WEB).digest("hex").slice(0, 16)}`);
/** A lock older than this was left by a run that stopped while it built, and is taken over. */
const STALE_LOCK_MS = 10 * 60_000;

/** The settings a build and the server run with: no framework telemetry, neither Next.js's nor the sign-in library's. */
const QUIET = { NEXT_TELEMETRY_DISABLED: "1", BETTER_AUTH_TELEMETRY: "0", NODE_ENV: "production" } as const;

/** Builds the web app for this run, unless another test file of the run has, and returns its standalone server. */
export async function buildWebApp(): Promise<string> {
  const run = inject("webAppRun");
  await takeLock();
  try {
    if (readOrNothing(BUILT_FOR) !== run) {
      const built = spawnSync(process.execPath, [NEXT_BIN, "build"], {
        cwd: WEB,
        env: { ...process.env, ...QUIET },
        encoding: "utf8",
        timeout: 280_000,
      });
      if (built.status !== 0) throw new Error(`next build failed:\n${built.stdout}\n${built.stderr}`);
      // The image serves the static files beside the standalone server, as the Dockerfile copies them.
      cpSync(join(WEB, ".next", "static"), join(STANDALONE, ".next", "static"), { recursive: true });
      writeFileSync(BUILT_FOR, run);
    }
  } finally {
    rmSync(BUILD_LOCK, { recursive: true, force: true });
  }
  return join(STANDALONE, "server.js");
}

async function takeLock(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(BUILD_LOCK);
      return;
    } catch {
      try {
        if (Date.now() - statSync(BUILD_LOCK).mtimeMs > STALE_LOCK_MS) rmSync(BUILD_LOCK, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      await sleep(250);
    }
  }
}

function readOrNothing(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export interface WebApp {
  /** The install's URL, TIEHALL_URL: http://localhost and the server's port. */
  url: string;
  /** Where a test's own calls reach the server: 127.0.0.1 and its port. */
  origin: string;
  /** The launch arguments that send a browser's calls to the install's URL to this server. */
  browserArgs: string[];
  /** Calls the server at this path, with no redirect followed. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** What the server printed. */
  output(): string;
  close(): Promise<void>;
}

/** Builds the web app for this run if it is not built yet, and starts its standalone server for the test install. */
export async function startWebApp(install: TestInstall): Promise<WebApp> {
  const server = await buildWebApp();
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [LAUNCHER, server], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...QUIET,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      TIEHALL_URL: url,
      TIEHALL_DATABASE_APP_URL: install.appDatabase.url,
      TIEHALL_DATABASE_APP_PASSWORD: install.appDatabase.password,
      TIEHALL_SECRET_KEY: install.secretKey,
      TIEHALL_AUTH_SECRET: install.authSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the web app exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/healthz`)).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the web app did not answer /healthz within 60 seconds:\n${output}`);
    }
    await sleep(100);
  }

  return {
    url,
    origin,
    browserArgs: [`--host-resolver-rules=MAP localhost 127.0.0.1`],
    fetch: (path, init = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    output: () => output,
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(10_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}
