import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

// The tiehall command for the end-to-end test of an install (agent-surfaces:
// The CLI package; agent-surfaces: CLI request commands; requester-loop:
// Claude Code Stop-hook waiter): the launcher bin/tiehall.mjs and the bundle
// it loads, built from the repository as the package's build builds them
// (packages/cli/rolldown.config.ts), into a folder of their own. Each person
// runs it on a machine of their own, a configuration folder and home that
// hold their saved login and nothing else; the command runs as a child
// process, as a person or a hook types it, and reaches the install over the
// network.

const CLI_PACKAGE = fileURLToPath(new URL("../../../packages/cli/", import.meta.url));

/** A run of the command: its exit code and what it printed. */
export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A run under way: what it has printed so far, and its end. */
export interface CliProcess {
  printed(): string;
  ended: Promise<CliRun>;
}

/** The tiehall command, built. */
export interface BuiltCli {
  /** The launcher, bin/tiehall.mjs, next to the bundle it loads. */
  bin: string;
  /** A machine of a person's own, where the command runs with their saved logins. */
  machine(): CliMachine;
  remove(): void;
}

/** Builds the tiehall command from the repository, as its package's build does. */
export async function buildCli(): Promise<BuiltCli> {
  const dir = mkdtempSync(join(tmpdir(), "tiehall-cli-build-"));
  mkdirSync(join(dir, "bin"));
  copyFileSync(join(CLI_PACKAGE, "bin/tiehall.mjs"), join(dir, "bin/tiehall.mjs"));
  await build({ cwd: CLI_PACKAGE, input: "src/main.ts", platform: "node", output: { file: join(dir, "dist/tiehall.mjs"), format: "esm" }, logLevel: "silent" });
  const bin = join(dir, "bin/tiehall.mjs");
  const machines: CliMachine[] = [];
  return {
    bin,
    machine() {
      const machine = new CliMachine(bin);
      machines.push(machine);
      return machine;
    },
    remove() {
      for (const machine of machines) machine.remove();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class CliMachine {
  /** The command's configuration folder and home on this machine. */
  readonly home: string;
  private readonly bin: string;

  constructor(bin: string) {
    this.bin = bin;
    this.home = mkdtempSync(join(tmpdir(), "tiehall-cli-home-"));
  }

  /** Starts `tiehall <args>` on this machine, with this standard input, and nothing of the test's environment but PATH. */
  start(args: readonly string[], options: { stdin?: string; timeoutSeconds?: number } = {}): CliProcess {
    const child = spawn(process.execPath, [this.bin, ...args], {
      cwd: this.home,
      env: { PATH: process.env["PATH"] ?? "", HOME: this.home, TIEHALL_CONFIG_DIR: this.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(options.stdin ?? "");
    const ended = new Promise<CliRun>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), (options.timeoutSeconds ?? 300) * 1000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    return { printed: () => stdout, ended };
  }

  /** Runs `tiehall <args>` on this machine until it exits. */
  run(args: readonly string[], options: { stdin?: string; timeoutSeconds?: number } = {}): Promise<CliRun> {
    return this.start(args, options).ended;
  }

  remove(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}
