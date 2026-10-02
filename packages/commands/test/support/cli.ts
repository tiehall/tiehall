import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccessHarness, SignedIn } from "./agent-access.ts";
import { URL_OF_INSTALL } from "./install.ts";

// The tiehall CLI for the end-to-end tests (agent-surfaces: CLI request
// commands; agent-surfaces: The CLI package; agent-access: The CLI signs in
// through a restricted device flow; design.md, Technical decisions: T17). The
// CLI runs in this process, as the Apache-2.0 package `tiehall` exports it,
// with its own configuration folder, and every call it makes goes through the
// agent-access harness, which answers as the web role routes a call, without
// the network, as the MCP contract tests' SDK clients do. A test can give
// other installs, by their origin, such as a second install that only signs
// in; a call to any other host fails as an unreachable host does, and every
// call the CLI makes is recorded, whichever host it was for.
//
// The CLI keeps its saved logins in `logins.json` in its configuration
// folder, which `TIEHALL_CONFIG_DIR` names, readable only by the user: one
// login per install URL, with its access token, its refresh token and when the
// access token expires. A test that is not about `tiehall login` saves the
// login of a member's CLI there, from the harness's device flow.

/** What the package `tiehall` exports: the CLI, run with the arguments after `tiehall`. */
export interface TiehallCli {
  run(environment: CliEnvironment): Promise<number>;
}

/** What one run of the CLI is given, in place of its process's. */
export interface CliEnvironment {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdin?(): Promise<string>;
  fetch?(request: Request): Promise<Response>;
  sleep?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now?(): Date;
  parentAlive?(): boolean;
}

/** What a run of the CLI printed, and its exit code. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** A call the CLI made. */
export interface CliCall {
  method: string;
  url: string;
  /** The Authorization header it carried, if any. */
  authorization: string | null;
  /** The CLI version it named in its Tiehall-CLI-Version header, if any. */
  cliVersion: string | null;
}

export interface CliMachine {
  /** The CLI's configuration folder on this machine. */
  configDir: string;
  /** Every call the CLI made, in order, whichever host it was for. */
  calls: CliCall[];
  /** Makes every later call name this CLI version, as an older or newer CLI's would. */
  pretendVersion(version: string): void;
  /** What the run under way has printed to its standard output so far. */
  printed(): string;
  /**
   * Runs `tiehall <args>`, with this standard input, this wait between polls, which is none unless given, and
   * these environment variables, until it exits.
   */
  run(
    args: readonly string[],
    options?: { stdin?: string; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>; env?: Record<string, string>; cwd?: string },
  ): Promise<CliRun>;
  /** Saves a login for this install, as `tiehall login` keeps it. */
  saveLogin(url: string, tokens: { accessToken: string; refreshToken: string }, expiresAt?: Date): void;
  /** The saved logins, by install URL, as the CLI keeps them. */
  logins(): Record<string, { accessToken: string; refreshToken: string; expiresAt: string }>;
  /** The mode of the file that holds the saved logins, such as 0o600. */
  loginsFileMode(): number;
  close(): void;
}

/** The file of saved logins in a configuration folder. */
export function loginsFile(configDir: string): string {
  return join(configDir, "logins.json");
}

/**
 * A machine with the CLI and a configuration folder of its own, whose calls
 * reach the harness's install at https://tiehall.example.com and these other
 * hosts, by origin.
 */
export function cliMachine(harness: AgentAccessHarness, others: Readonly<Record<string, (request: Request) => Promise<Response>>> = {}): CliMachine {
  const configDir = mkdtempSync(join(tmpdir(), "tiehall-cli-"));
  const calls: CliCall[] = [];
  let printed = "";
  let version: string | undefined;
  const fetch = async (request: Request): Promise<Response> => {
    if (version !== undefined) request.headers.set("tiehall-cli-version", version);
    calls.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), cliVersion: request.headers.get("tiehall-cli-version") });
    const { origin } = new URL(request.url);
    if (origin === URL_OF_INSTALL) return harness.handle(request);
    const other = others[origin];
    if (other !== undefined) return other(request);
    throw new TypeError(`fetch failed: ${origin} cannot be reached from this machine`);
  };
  return {
    configDir,
    calls,
    printed: () => printed,
    pretendVersion(named) {
      version = named;
    },
    async run(args, options = {}) {
      // Imported when a test runs, so that a missing command fails that test rather than the file.
      const cli = (await import("tiehall")) as unknown as Partial<TiehallCli>;
      if (typeof cli.run !== "function") throw new Error("The package tiehall does not export run() yet.");
      let stderr = "";
      printed = "";
      const code = await cli.run({
        argv: args,
        env: { TIEHALL_CONFIG_DIR: configDir, HOME: configDir, ...options.env },
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdout: (text) => void (printed += text),
        stderr: (text) => void (stderr += text),
        stdin: async () => options.stdin ?? "",
        fetch,
        sleep: options.sleep ?? (async () => {}),
      });
      return { code, stdout: printed, stderr };
    },
    saveLogin(url, tokens, expiresAt = new Date(Date.now() + 10 * 60_000)) {
      mkdirSync(configDir, { recursive: true });
      const file = loginsFile(configDir);
      const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { logins: Record<string, unknown> }) : { logins: {} };
      saved.logins[url] = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: expiresAt.toISOString() };
      writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    },
    logins() {
      const file = loginsFile(configDir);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { logins: ReturnType<CliMachine["logins"]> }).logins : {};
    },
    loginsFileMode() {
      return statSync(loginsFile(configDir)).mode & 0o777;
    },
    close() {
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

/** Waits this long in real time, or until the signal aborts: the wait a long-running command, such as a hook's, needs. */
export function realSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Acknowledges every update the machine's CLI has, through `tiehall updates`,
 * so that its hooks see only what comes next; returns the cursor it leaves.
 */
export async function acknowledgeEverything(machine: CliMachine): Promise<number> {
  let cursor = 0;
  for (;;) {
    const read = await machine.run(["updates", "--json", "--limit", "50"]);
    if (read.code !== 0) throw new Error(`tiehall updates answered ${read.stderr}`);
    const page = JSON.parse(read.stdout) as { events: { number: number }[]; cursor: number };
    cursor = page.cursor;
    if (page.events.length === 0) return cursor;
    await machine.run(["updates", "--json", "--limit", "1", "--acknowledge", String(Math.max(...page.events.map(({ number }) => number)))]);
  }
}

/** A member's CLI, signed in to the harness's install through the device flow, on a machine of its own. */
export async function signedInCli(harness: AgentAccessHarness, person: SignedIn): Promise<CliMachine> {
  const machine = cliMachine(harness);
  machine.saveLogin(URL_OF_INSTALL, await harness.signInCli(person));
  return machine;
}

/**
 * Another install, at this URL, that only signs a CLI in: its device flow
 * gives a code and, at the first poll, tokens of its own, numbered by
 * sign-in; any other call gets 404.
 */
export function signInOnlyInstall(url: string): { handle(request: Request): Promise<Response>; signIns: number } {
  const install = {
    signIns: 0,
    async handle(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/auth/device/code") {
        return Response.json({ device_code: "device-code", user_code: "NETW-CODE", verification_uri: `${url}/device`, expires_in: 600, interval: 5 });
      }
      if (request.method === "POST" && pathname === "/api/auth/oauth2/token") {
        install.signIns += 1;
        return Response.json({ access_token: `access-${install.signIns}`, refresh_token: `refresh-${install.signIns}`, token_type: "Bearer", expires_in: 600 });
      }
      return new Response("Not found", { status: 404 });
    },
  };
  return install;
}
