import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./logins.ts";

// The mark of the news the CLI has announced (requester-loop: News is
// announced once; design.md, Technical decisions: T15). The SessionStart
// digest and the Stop-hook waiter share it, and so does `tiehall watch`,
// which stands in for the waiter: the number of the last update one of them
// announced, one per install, in `announced.json` in the CLI's configuration
// folder, which is the user's own, readable and writable only by them, mode
// 0600, like the saved logins. None of them announces an update the mark
// holds, and each adds to the mark the updates it announces before it
// announces them, under a lock, so that two sessions, or a digest and a
// waiter, never announce one update twice. The mark acknowledges nothing: the
// install never hears of it, and an announced update stays in every pull
// reader until the user or their agent acknowledges it. Signing in to an
// install again starts its mark anew, since the new login may be another
// user's.

/** The file's contents: each install's mark, by the install's URL. */
interface AnnouncedFile {
  installs: Record<string, { through: number }>;
}

function fileOf(configDir: string): string {
  return join(configDir, "announced.json");
}

function read(configDir: string): AnnouncedFile {
  const file = fileOf(configDir);
  if (!existsSync(file)) return { installs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AnnouncedFile> | null;
    const installs = parsed?.installs;
    return { installs: typeof installs === "object" && installs !== null ? installs : {} };
  } catch {
    // A file the CLI cannot read holds no mark; the next announcement writes it anew.
    return { installs: {} };
  }
}

function write(configDir: string, contents: AnnouncedFile): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = fileOf(configDir);
  const written = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(written, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(written, 0o600);
    renameSync(written, file);
  } finally {
    rmSync(written, { force: true });
  }
}

/** Waits in real time: the lock is between processes, whatever clock a command keeps. */
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The number of the last update announced for the install at this URL; 0 before the first. */
export function announcedThrough(configDir: string, url: string): number {
  const through = read(configDir).installs[url]?.through;
  return typeof through === "number" && Number.isSafeInteger(through) && through > 0 ? through : 0;
}

/**
 * Announces what `choose` picks from the updates the mark does not hold: under
 * the lock, it gives `choose` the install's mark, and moves the mark up to the
 * number `choose` answers, never back, before it returns what `choose` picked.
 * Nothing is picked, and nothing moves, when `choose` answers undefined.
 */
export function announce<T>(configDir: string, url: string, choose: (through: number) => { through: number; picked: T } | undefined): Promise<T | undefined> {
  return withFileLock(configDir, "announced.lock", pause, async () => {
    const contents = read(configDir);
    const through = announcedThrough(configDir, url);
    const chosen = choose(through);
    if (chosen === undefined) return undefined;
    if (chosen.through > through) {
      contents.installs[url] = { through: chosen.through };
      write(configDir, contents);
    }
    return chosen.picked;
  });
}

/** Forgets the install's mark, as a new sign-in to it does. */
export function forgetAnnounced(configDir: string, url: string): Promise<void> {
  return withFileLock(configDir, "announced.lock", pause, async () => {
    const contents = read(configDir);
    if (!Object.hasOwn(contents.installs, url)) return;
    delete contents.installs[url];
    write(configDir, contents);
  });
}
