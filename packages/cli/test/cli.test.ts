import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_TABLE } from "@tiehall/client";
import { NODE_MAJOR_MINIMUM, run } from "../src/index.ts";
import { RENDERERS } from "../src/output.ts";

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

  it.fails("lists updates, contract diff, contract report, hook session-start and hook wait, which tasks 19.3, 19.11, 19.13, 22.11 and 23.5 add", () => {
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
