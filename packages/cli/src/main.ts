import process from "node:process";
import { run } from "./run.ts";

// The `tiehall` command's entry, which bin/tiehall.mjs starts once it has
// checked the Node.js version (agent-surfaces: The CLI package): it runs one
// command with the process's arguments, environment, output and network, and
// exits with the command's code.

/** Reads the whole standard input, for an option given as -. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<void> {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: readStdin,
    fetch: (request) => fetch(request),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}
