import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The plugin's hook launcher (requester-loop: The hooks stay quiet without the
// CLI; agent-surfaces: The Claude Code plugin; design.md, Technical
// decisions: T15). Claude Code runs `sh hooks/tiehall-hook.sh <name>` for each
// of the plugin's hooks, with the hook's input on standard input, and the
// launcher runs `tiehall hook <name>` with the install whose URL the plugin
// was given, TIEHALL_URL. Without the tiehall command, a session starts and a
// turn ends as if the plugin had no hooks: each hook exits with 0 at once and
// writes nothing that reaches Claude, and nothing wakes it. Only the waiter's
// error output is passed on, since it is the reminder that wakes Claude; the
// other hooks' is dropped. With a CLI older than the install's minimum, the
// install answers 400 upgrade-required: the digest prints no updates and the
// waiter exits without code 2 and without calling again.

const launcher = fileURLToPath(new URL("../hooks/tiehall-hook.sh", import.meta.url));
const cliMain = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "tiehall-launcher-"));
/** A folder with no tiehall command, which is all the PATH holds on a machine without the CLI. */
const empty = join(scratch, "empty");
/** A folder with a stand-in tiehall command, which says how it was run and exits with FAKE_CODE. */
const fake = join(scratch, "fake");
/** A PATH that finds the stand-in, and the system's commands it uses. */
const withFake = `${fake}:/usr/bin:/bin`;
/** A folder with the real tiehall command, run from its source. */
const real = join(scratch, "real");
const INPUT = JSON.stringify({ session_id: "session-1", transcript_path: "/home/sam/t.jsonl", cwd: "/home/sam/app", hook_event_name: "Stop" });

beforeAll(() => {
  for (const folder of [empty, fake, real]) mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(fake, "tiehall"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*"\ncat > "$FAKE_INPUT"\nprintf \'noise from the CLI\\n\' >&2\nexit "${FAKE_CODE:-0}"\n',
  );
  chmodSync(join(fake, "tiehall"), 0o755);
  writeFileSync(join(real, "entry.mjs"), `import(${JSON.stringify(cliMain)}).then((cli) => cli.main());\n`);
  writeFileSync(join(real, "tiehall"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(real, "entry.mjs"))} "$@"\n`);
  chmodSync(join(real, "tiehall"), 0o755);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the launcher as Claude Code runs a hook: with sh, the hook's input on standard input, and this PATH and environment. */
function launch(hook: string, path: string, env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [launcher, hook], { env: { PATH: path, HOME: scratch, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    // A hook may exit before it reads its input, as the launcher does without
    // the CLI, and writing the input then fails with EPIPE; that says nothing
    // about the hook. Any other failure to write the input fails the test.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(INPUT);
  });
}

describe("without the tiehall command", () => {
  // requester-loop: The hooks stay quiet without the CLI, "A session starts without the CLI".
  it("lets a session start: the SessionStart hook exits with 0 and writes nothing", async () => {
    expect(await launch("session-start", empty)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  // requester-loop: The hooks stay quiet without the CLI, "A turn ends without the CLI".
  it("lets a turn end: the Stop hook exits with 0 at once, writes nothing, and wakes nothing", async () => {
    const started = Date.now();
    expect(await launch("wait", empty)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("lets a session end: the SessionEnd hook exits with 0 and writes nothing", async () => {
    expect(await launch("session-end", empty)).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("with the tiehall command", () => {
  it("runs tiehall hook <name> with the hook's input, for the install whose URL the plugin was given", async () => {
    const input = join(scratch, "input-1");
    const ran = await launch("session-start", withFake, { FAKE_INPUT: input, TIEHALL_URL: "https://tiehall.example.com" });
    expect(ran).toEqual({ code: 0, stdout: "hook session-start --install https://tiehall.example.com\n", stderr: "" });
    expect(readFileSync(input, "utf8")).toBe(INPUT);
  });

  it("runs it without --install when the plugin was given no URL, so the CLI uses its one saved login", async () => {
    const ran = await launch("session-end", withFake, { FAKE_INPUT: join(scratch, "input-2") });
    expect(ran).toEqual({ code: 0, stdout: "hook session-end\n", stderr: "" });
  });

  it("passes on the waiter's error output and its code 2, which wake Claude, and drops the other hooks' error output", async () => {
    const woken = await launch("wait", withFake, { FAKE_INPUT: join(scratch, "input-3"), FAKE_CODE: "2" });
    expect(woken).toEqual({ code: 2, stdout: "hook wait\n", stderr: "noise from the CLI\n" });
    const digest = await launch("session-start", withFake, { FAKE_INPUT: join(scratch, "input-4"), FAKE_CODE: "0" });
    expect(digest.stderr).toBe("");
  });

  it("runs nothing for a hook it does not know", async () => {
    expect(await launch("pre-tool-use", withFake, { FAKE_INPUT: join(scratch, "input-5") })).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

// agent-surfaces: The Claude Code plugin, "A hook runs an old CLI".
describe("with a tiehall command older than the install's minimum", () => {
  let server: Server;
  let url: string;
  const calls: string[] = [];
  let configDir: string;

  beforeAll(async () => {
    // The install refuses every call of this CLI, as it refuses one older than its minimum.
    server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.writeHead(400, { "content-type": "application/problem+json" });
      response.end(
        JSON.stringify({
          type: "https://tiehall.com/problems/upgrade-required",
          title: "Upgrade required",
          status: 400,
          detail: "This tiehall CLI is version 0.1.0, and this install needs version 9.0.0 or later: upgrade it with npm install --global tiehall@latest, and run the command again.",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
    configDir = join(scratch, "config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(configDir, "logins.json"),
      JSON.stringify({ logins: { [url]: { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }),
      { mode: 0o600 },
    );
  });

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it("prints no updates at the start of a session: the install answers 400 upgrade-required, and no update is fetched", async () => {
    calls.length = 0;
    expect(await launch("session-start", `${real}:/usr/bin:/bin`, { TIEHALL_URL: url, TIEHALL_CONFIG_DIR: configDir })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(calls).toEqual(["POST /api/v1/updates"]);
  });

  it("ends the waiter without code 2, without a word, and without calling again", async () => {
    calls.length = 0;
    expect(await launch("wait", `${real}:/usr/bin:/bin`, { TIEHALL_URL: url, TIEHALL_CONFIG_DIR: configDir })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(calls).toEqual(["GET /api/v1/events/wait"]);
  });
});
