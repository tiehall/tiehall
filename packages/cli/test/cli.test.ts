import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_TABLE } from "@tiehall/client";
import { NODE_MAJOR_MINIMUM, run } from "../src/index.ts";
import { RENDERERS } from "../src/output.ts";
import { sessionLockPath } from "../src/session-lock.ts";

// The tiehall package (agent-surfaces: The CLI package; agent-surfaces: CLI
// request commands; public-api: Request bodies have a size limit). It runs on
// Node.js 22 or later, which its engines field says and its command checks at
// startup, before it loads anything else; it bundles @tiehall/client, from
// whose command table its request commands come, each with a renderer for
// its answer; and it shows a refusal of the install as the install wrote it.

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const launcher = join(packageRoot, "bin/tiehall.mjs");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { engines: { node: string }; bin: Record<string, string> };
const scratch = mkdtempSync(join(tmpdir(), "tiehall-cli-"));

beforeAll(async () => {
  // The bundle the tiehall command loads, as the package's build writes it.
  await build({ cwd: packageRoot, input: "src/main.ts", platform: "node", output: { file: join(packageRoot, "dist/tiehall.mjs"), format: "esm" }, logLevel: "silent" });
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the tiehall command as a child process, with this Node.js version when one is given. */
function tiehall(args: readonly string[], nodeVersion?: string) {
  const preload = nodeVersion === undefined ? [] : ["--import", `data:text/javascript,Object.defineProperty(process.versions,"node",{value:${JSON.stringify(nodeVersion)}})`];
  const child = spawnSync(process.execPath, [...preload, launcher, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", TIEHALL_CONFIG_DIR: scratch } });
  if (child.error) throw child.error;
  return child;
}

/** Whether the process with this id still runs. */
function runs(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs one command in this process, with this fetch. */
async function inProcess(args: readonly string[], fetch?: (request: Request) => Promise<Response>) {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: args,
    env: { TIEHALL_CONFIG_DIR: scratch },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    ...(fetch === undefined ? {} : { fetch }),
  });
  return { code, stdout, stderr };
}

describe("the package", () => {
  it("runs on Node.js 22 or later, as its engines field says, and gives the tiehall command", () => {
    expect(manifest.engines.node).toBe(`>=${NODE_MAJOR_MINIMUM}`);
    expect(manifest.bin).toEqual({ tiehall: "bin/tiehall.mjs" });
    expect(readFileSync(launcher, "utf8")).toContain(`var MINIMUM = ${NODE_MAJOR_MINIMUM};`);
  });

  it("refuses to start on an older Node.js, and says which it needs", () => {
    const child = tiehall(["--help"], "20.11.0");
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("tiehall needs Node.js 22 or later, and this is Node.js 20.11.0. Install Node.js 22 or later, and run tiehall again.\n");
  });

  it("starts on Node.js 22, from the bundle, which holds the client", () => {
    const child = tiehall(["--version"], "22.0.0");
    expect(child.stderr).toBe("");
    expect(child.stdout).toMatch(/^tiehall \d+\.\d+\.\d+/);
    expect(child.status).toBe(0);
    const bundle = readFileSync(join(packageRoot, "dist/tiehall.mjs"), "utf8");
    expect(bundle).not.toMatch(/from\s+"@tiehall\/client"|from\s+"openapi-fetch"/);
  });

  // agent-surfaces: The CLI package, "Installing the CLI".
  it("lists the request commands, and no audit command", () => {
    const child = tiehall(["--help"]);
    expect(child.status).toBe(0);
    for (const command of ["inbox", "get", "open", "ask", "reply", "propose", "status", "claim", "link-pr"]) {
      expect(child.stdout, command).toMatch(new RegExp(`^  tiehall ${command}\\b`, "m"));
    }
    expect(child.stdout).not.toMatch(/\baudit\b/);
  });

  it("lists login, which task 17.4 added", () => {
    const child = tiehall(["--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^  tiehall login\b/m);
  });

  it("lists updates, which task 19.3 added", () => {
    const child = tiehall(["--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^  tiehall updates\b/m);
  });

  it("lists hook session-start and hook wait, which tasks 19.13 and 19.11 added", () => {
    const child = tiehall(["--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^  tiehall hook session-start\b/m);
    expect(child.stdout).toMatch(/^  tiehall hook wait\b/m);
  });

  it("lists contract report, which task 22.11 added, once", () => {
    const child = tiehall(["--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout.match(/^  tiehall contract report\b/gm)).toHaveLength(1);
  });

  it("lists updates, contract diff, contract report, hook session-start and hook wait, which tasks 19.3, 19.11, 19.13, 22.11 and 23.5 added", () => {
    const child = tiehall(["--help"]);
    for (const command of ["updates", "contract diff", "contract report", "hook session-start", "hook wait"]) {
      expect(child.stdout, command).toMatch(new RegExp(`^  tiehall ${command}\\b`, "m"));
    }
  });

  it("shows each command's arguments and options", () => {
    const child = tiehall(["reply", "--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("Usage: tiehall reply <key> <body> [options]");
    expect(child.stdout).toContain("--question-id <string> (required)");
    expect(child.stdout).not.toContain("--kind");
  });
});

// requester-loop: Claude Code Stop-hook waiter. The hooks run the tiehall command as Claude Code starts it, with
// Claude Code's input on its standard input; a hook that cannot do its work ends without a word, and one whose
// standard input never ends still ends.
describe("the hook commands, as Claude Code runs them", () => {
  it("end without a word when the CLI is not signed in", () => {
    for (const hook of ["wait", "session-end"]) {
      const child = spawnSync(process.execPath, [launcher, "hook", hook], {
        encoding: "utf8",
        input: JSON.stringify({ session_id: "session-1", hook_event_name: "Stop" }),
        env: { PATH: process.env["PATH"] ?? "", TIEHALL_CONFIG_DIR: scratch },
      });
      expect({ hook, status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ hook, status: 0, stdout: "", stderr: "" });
    }
  });

  // requester-loop: Claude Code Stop-hook waiter: a waiter whose session has ended exits.
  it("end the waiter, and free its lock, once the Claude Code that started it has stopped", async () => {
    const waits: string[] = [];
    const server = createServer((request) => void waits.push(request.url ?? ""));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const configDir = mkdtempSync(join(tmpdir(), "tiehall-orphan-"));
    writeFileSync(
      join(configDir, "logins.json"),
      JSON.stringify({ logins: { [url]: { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }),
      { mode: 0o600 },
    );
    try {
      // A stand-in for Claude Code: it starts the waiter, as the Stop hook does, and stops without ending the session.
      // It runs beside this process's server, which the waiter calls, so it is not run synchronously.
      const claude = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
           const waiter = spawn(process.execPath, [${JSON.stringify(launcher)}, "hook", "wait"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH, TIEHALL_CONFIG_DIR: ${JSON.stringify(configDir)} } });
           waiter.stdin.end(JSON.stringify({ session_id: "session-orphan", hook_event_name: "Stop" }));
           process.stdout.write(String(waiter.pid));
           setTimeout(() => process.exit(0), 1500);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let printed = "";
      claude.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
      await new Promise((resolve) => claude.on("exit", resolve));
      const pid = Number(printed);
      expect(pid).toBeGreaterThan(0);
      expect(waits).toEqual(["/api/v1/events/wait"]);
      const until = Date.now() + 30_000;
      while (Date.now() < until && runs(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runs(pid)).toBe(false);
      expect(existsSync(sessionLockPath(configDir, "session-orphan"))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("stop cleanly when asked to, as tiehall watch does: with 0, without a word", async () => {
    const waits: string[] = [];
    const server = createServer((request) => void waits.push(request.url ?? ""));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const configDir = mkdtempSync(join(tmpdir(), "tiehall-stop-"));
    writeFileSync(
      join(configDir, "logins.json"),
      JSON.stringify({ logins: { [url]: { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }),
      { mode: 0o600 },
    );
    try {
      for (const [args, signal] of [
        [["watch"], "SIGTERM"],
        [["watch"], "SIGINT"],
        [["hook", "wait"], "SIGTERM"],
      ] as const) {
        const before = waits.length;
        const child = spawn(process.execPath, [launcher, ...args], { env: { PATH: process.env["PATH"] ?? "", TIEHALL_CONFIG_DIR: configDir }, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.end(JSON.stringify({ session_id: "session-stop", hook_event_name: "Stop" }));
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
        const until = Date.now() + 30_000;
        while (waits.length === before && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
        child.kill(signal);
        expect({ args, signal, code: await exited, output }).toEqual({ args, signal, code: 0, output: "" });
      }
      expect(existsSync(sessionLockPath(configDir, "session-stop"))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // requester-loop: Claude Code Stop-hook waiter: everything the waiter writes to its error output reaches Claude,
  // so a hook command that cannot start writes nothing there, and ends as one that cannot do its work does.
  it("end without a word on a Node.js older than the CLI needs, while other commands still say which it needs", () => {
    for (const hook of ["wait", "session-start", "session-end"]) {
      const child = tiehall(["hook", hook], "20.11.0");
      expect({ hook, status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ hook, status: 0, stdout: "", stderr: "" });
    }
    expect(tiehall(["updates"], "20.11.0").stderr).toContain("tiehall needs Node.js 22 or later");
  });

  it("end without a word when the CLI cannot load, while other commands still say why", () => {
    // The command without its bundle, as a broken install of the package leaves it.
    const broken = mkdtempSync(join(tmpdir(), "tiehall-broken-"));
    try {
      mkdirSync(join(broken, "bin"));
      copyFileSync(launcher, join(broken, "bin/tiehall.mjs"));
      const start = (args: readonly string[]) =>
        spawnSync(process.execPath, [join(broken, "bin/tiehall.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", TIEHALL_CONFIG_DIR: scratch } });
      const hook = start(["hook", "wait"]);
      expect({ status: hook.status, stdout: hook.stdout, stderr: hook.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
      const other = start(["updates"]);
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/^tiehall could not start: /);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("end when their standard input never does", async () => {
    const child = spawn(process.execPath, [launcher, "hook", "wait"], { env: { PATH: process.env["PATH"] ?? "", TIEHALL_CONFIG_DIR: scratch }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect({ code, output }).toEqual({ code: 0, output: "" });
  });
});

describe("the request commands", () => {
  it("each have text for their operation's answer", () => {
    expect(COMMAND_TABLE.length).toBeGreaterThanOrEqual(9);
    for (const { command, operationId } of COMMAND_TABLE) expect(RENDERERS[operationId], command).toBeTypeOf("function");
  });

  it("refuse a command that does not exist, and point to the list", async () => {
    const result = await inProcess(["decline", "FE-142"]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toBe("tiehall has no command decline. Run tiehall --help for its commands.\n");
  });

  it("say how to sign in when the CLI has no saved login, and call nothing", async () => {
    const calls: Request[] = [];
    const result = await inProcess(["inbox"], async (request) => {
      calls.push(request);
      return Response.json({});
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run tiehall login <url>");
    expect(calls).toEqual([]);
  });
});

// public-api: Request bodies have a size limit; request-body-limit 1.4. The install refuses a body over its limit
// with 413 and the problem type payload-too-large, before it reads it, and the CLI shows that problem as it shows
// every problem: its title and its detail, which names the limit.
describe("a refusal for a body over the limit", () => {
  it("prints the problem's title and its detail, which names the limit, and exits with 1", async () => {
    writeFileSync(
      join(scratch, "logins.json"),
      JSON.stringify({ logins: { "https://tiehall.example.com": { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }),
      { mode: 0o600 },
    );
    const sent: Request[] = [];
    const problem = {
      type: "https://tiehall.com/problems/payload-too-large",
      title: "Request body too large",
      status: 413,
      detail: "The request body is larger than 2 MiB, the limit on this operation's body; it is not read, and nothing runs.",
    };
    const result = await inProcess(["open", "FE", "--title", "Big", "--packet", JSON.stringify({ need: "x".repeat(10) })], async (request) => {
      sent.push(request);
      return Response.json(problem, { status: 413, headers: { "content-type": "application/problem+json" } });
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Request body too large: ${problem.detail}\n`);
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST https://tiehall.example.com/api/v1/requests"]);
    rmSync(join(scratch, "logins.json"));
  });
});
