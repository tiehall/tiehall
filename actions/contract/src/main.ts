import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { runAction, type ExecResult } from "./action.ts";

// The contract Action's entry, which the runner starts with its own Node.js 24
// (action.yml): it runs the Action once with the step's environment, output
// and network, and ends the step with the Action's exit code. Programs run
// without a shell, each with its arguments as a list.

/** Runs a program to its end, without a shell, and gives back what it printed. */
function exec(file: string, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string | undefined>> }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

process.exitCode = await runAction({
  env: process.env,
  exec,
  fetch: (request) => fetch(request),
  stdout: (text) => void process.stdout.write(text),
  sleep: (ms) => delay(ms),
  platform: process.platform,
  arch: process.arch,
});
