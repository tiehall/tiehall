import process from "node:process";
import { sleepOf } from "./environment.ts";
import { run } from "./run.ts";

// The `tiehall` command's entry, which bin/tiehall.mjs starts once it has
// checked the Node.js version (agent-surfaces: The CLI package): it runs one
// command with the process's arguments, environment, output, network and
// clock, and exits with the command's code. The process that started it is
// the one it asks after: for a hook, the Claude Code that runs it
// (requester-loop: Claude Code Stop-hook waiter).

let readingStdin = false;

/** Reads the whole standard input, for an option given as - or a hook's input. */
async function readStdin(): Promise<string> {
  readingStdin = true;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether the process that started this one still runs: this process has not
 * been handed to another parent, and its parent exists, even one this user may
 * not signal.
 */
function parentAlive(parent: number): () => boolean {
  return () => {
    if (process.ppid !== parent) return false;
    try {
      process.kill(parent, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
}

/**
 * A signal that aborts when the process is asked to stop, by Ctrl-C, SIGTERM
 * or SIGHUP; only a command that asks for it takes those signals over, and a
 * second one stops the process as usual.
 */
function interruptions(): () => AbortSignal {
  let interruption: AbortController | undefined;
  return () => {
    if (interruption === undefined) {
      const controller = new AbortController();
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => controller.abort());
      interruption = controller;
    }
    return interruption.signal;
  };
}

export async function main(): Promise<void> {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: readStdin,
    fetch: (request) => fetch(request),
    sleep: sleepOf({ argv: [], env: {}, stdout: () => {}, stderr: () => {} }),
    parentAlive: parentAlive(process.ppid),
    interrupted: interruptions(),
  });
  // A hook that stopped reading an input that never ended leaves nothing open behind it.
  if (readingStdin) process.stdin.destroy();
}
