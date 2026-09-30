import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";

// The lock of a Claude Code session's waiter (requester-loop: Claude Code
// Stop-hook waiter; design.md, Technical decisions: T15). At most one
// `tiehall hook wait` waits for a Claude Code session, and the CLI itself
// enforces it: the waiter holds its session's lock, a local socket that it
// listens on, named after the session in the CLI's configuration folder
// (a named pipe on Windows), which only the user can reach. The operating
// system frees it when the waiter's process exits, however it exits: a socket
// nobody listens on is taken over. A waiter armed at the end of a later turn
// of the same session asks the one that holds the lock to go, over the
// socket, and takes the lock once it has; so does the plugin's SessionEnd
// hook, through `tiehall hook session-end`, which then leaves the lock free.
// A waiter asked to go stops waiting at once, and writes nothing.

/** The longest path of a local socket that every system takes; macOS takes 103 bytes. */
const LONGEST_SOCKET_PATH = 100;

/** How long a waiter asked to go has to answer, in real time; one that does not is left to its cap. */
const ANSWER_MS = 5_000;

/** How many times a new waiter tries to take a lock that others hold or left behind. */
const ATTEMPTS = 5;

/** The digest of a session, in hexadecimal, that names its lock. */
function digestOf(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

/**
 * Where the lock of a Claude Code session is: a socket in the `sessions`
 * folder of the CLI's configuration folder; when that path is longer than a
 * local socket's may be, one in a folder of the user's own under /tmp; on
 * Windows, a named pipe.
 */
export function sessionLockPath(configDir: string, sessionId: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\tiehall-${digestOf(configDir, sessionId).slice(0, 32)}`;
  const path = join(configDir, "sessions", `${digestOf(sessionId).slice(0, 16)}.sock`);
  if (Buffer.byteLength(path) <= LONGEST_SOCKET_PATH) return path;
  return join("/tmp", `tiehall-${process.getuid?.() ?? "user"}`, `${digestOf(configDir, sessionId).slice(0, 24)}.sock`);
}

/** Makes the lock's folder, which only the user may enter; a folder under /tmp that is not the user's own is refused. */
function prepareFolder(path: string): void {
  if (process.platform === "win32") return;
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error("The folder of the session locks is not the user's own.");
  }
}

/** A session's lock, held by this waiter. */
export interface SessionLock {
  /** Aborts when another waiter of the session, or the session's end, asks this waiter to go; the lock is free by then. */
  readonly released: AbortSignal;
  /** Frees the lock, unless it was freed when this waiter was asked to go. */
  close(): void;
}

/** Listens on the lock's socket: the lock, or undefined when another process listens there or left its socket behind. */
function listen(path: string): Promise<SessionLock | undefined> {
  return new Promise((resolve, reject) => {
    const released = new AbortController();
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let heard = "";
      socket.on("error", () => {});
      socket.on("data", (chunk: string) => {
        heard += chunk;
        if (!heard.includes("release\n")) return;
        // Closing the server frees its path at once, before this waiter has stopped; the one that asked then listens.
        if (server.listening) server.close();
        released.abort();
        socket.end("released\n");
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen(path, () =>
      resolve({
        released: released.signal,
        close: () => {
          if (server.listening) server.close();
        },
      }),
    );
  });
}

/** Asks the waiter that listens on the lock's socket to go: it went, the socket is one nobody listens on, or no answer came. */
function askToGo(path: string): Promise<"gone" | "stale" | "silent"> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("silent");
    }, ANSWER_MS);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("release\n"));
    // Its answer, "released", comes before it closes the connection; the lock is free by then.
    socket.on("data", () => {});
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ENOTSOCK" ? "stale" : "silent");
    });
    socket.on("close", () => {
      clearTimeout(timer);
      // A waiter that closed without an answer was on its way out; the next attempt finds out.
      resolve("gone");
    });
  });
}

/**
 * Takes the lock of a session for this waiter: at once when it is free, after
 * asking the waiter that holds it to go, or after removing a socket nobody
 * listens on. Undefined when it cannot, such as when the waiter that holds it
 * does not answer.
 */
export async function acquireSessionLock(configDir: string, sessionId: string): Promise<SessionLock | undefined> {
  const path = sessionLockPath(configDir, sessionId);
  prepareFolder(path);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const lock = await listen(path);
    if (lock !== undefined) return lock;
    const outcome = await askToGo(path);
    if (outcome === "stale") rmSync(path, { force: true });
    if (outcome === "silent") return undefined;
  }
  return undefined;
}

/** Ends a session's waiter, if one waits, and leaves its lock free, as the session's end does. */
export async function releaseSessionLock(configDir: string, sessionId: string): Promise<void> {
  const path = sessionLockPath(configDir, sessionId);
  if (process.platform !== "win32" && !existsSync(path)) return;
  if ((await askToGo(path)) === "stale") rmSync(path, { force: true });
}
