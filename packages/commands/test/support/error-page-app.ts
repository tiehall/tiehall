import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";
import type { TestInstall } from "./install.ts";

// The fixture app of a page that fails while it renders
// (apps/web/test/fixtures/error-page/; web-ui: The content security policy of
// each kind of page; design.md, Design: Testing; D57 (9)): its one page, at
// /fails/now, throws, so Next.js shows the web app's own page for a failed render in its
// place, under the policy the web app's proxy gives it. It is built with `next
// build` once per run of this project between the test files that start it,
// and started with `next start` with a test install's settings, which the
// proxy's setup gate reads, at http://localhost and a free port, where it
// listens on 127.0.0.1; a browser reaches it there through the same
// host-resolver rule as the web app (web-app.ts).

const FIXTURE = fileURLToPath(new URL("../../../../apps/web/test/fixtures/error-page/", import.meta.url));
const NEXT_BIN = createRequire(join(FIXTURE, "..", "..", "..", "package.json")).resolve("next/dist/bin/next");
const BUILT_FOR = join(FIXTURE, ".next", "tiehall-test-run");
const BUILD_LOCK = join(tmpdir(), `tiehall-error-page-build-${createHash("sha256").update(FIXTURE).digest("hex").slice(0, 16)}`);
const STALE_LOCK_MS = 10 * 60_000;
const QUIET = { NEXT_TELEMETRY_DISABLED: "1", BETTER_AUTH_TELEMETRY: "0", NODE_ENV: "production" } as const;

export interface ErrorPageApp {
  /** The app's URL: http://localhost and its port. */
  url: string;
  /** Where a test's own calls reach it: 127.0.0.1 and its port. */
  origin: string;
  close(): Promise<void>;
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

/** Builds the fixture app for this run, unless another test file of the run has. */
async function build(): Promise<void> {
  const run = inject("webAppRun");
  await takeLock();
  try {
    let built: string | undefined;
    try {
      built = readFileSync(BUILT_FOR, "utf8");
    } catch {
      built = undefined;
    }
    if (built !== run) {
      const result = spawnSync(process.execPath, [NEXT_BIN, "build", FIXTURE], { cwd: FIXTURE, env: { ...process.env, ...QUIET }, encoding: "utf8", timeout: 280_000 });
      if (result.status !== 0) throw new Error(`next build of the error-page fixture failed:\n${result.stdout}\n${result.stderr}`);
      writeFileSync(BUILT_FOR, run);
    }
  } finally {
    rmSync(BUILD_LOCK, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Builds the fixture app if it is not built yet for this run, and starts it with the test install's settings. */
export async function startErrorPageApp(install: TestInstall): Promise<ErrorPageApp> {
  await build();
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "start", FIXTURE, "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: FIXTURE,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...QUIET,
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
    if (child.exitCode !== null) throw new Error(`the error-page fixture exited with ${child.exitCode}:\n${output}`);
    try {
      await fetch(`${origin}/`, { headers: { accept: "text/html" } });
      break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the error-page fixture did not answer within 60 seconds:\n${output}`);
    }
    await sleep(100);
  }
  return {
    url,
    origin,
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(10_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}
