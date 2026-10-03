import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./logins.ts";

// The mark of the news the CLI has announced (requester-loop: News is
// announced once; design.md, Technical decisions: T15). The SessionStart
// digest and the Stop-hook waiter share it, and so does `tiehall watch`,
// which stands in for the waiter: the number of the last update one of them
// announced, one per user and install, in `announced.json` in the CLI's
// configuration folder, which is the user's own, readable and writable only
// by them, mode 0600, like the saved logins. None of them announces an update
// the mark holds, and each adds to the mark the updates it announces before
// it announces them, under a lock, so that two sessions, or a digest and a
// waiter, never announce one update twice. The mark acknowledges nothing: the
// install never hears of it, and an announced update stays in every pull
// reader until the user or their agent acknowledges it.
//
// A login names its user by the id whoami gave when the CLI signed in
// (logins.ts), and the mark is that user's on that install: signing in again
// as the same user keeps it, and another user's login has a mark of its own.
// A login an earlier CLI saved names no user: it keeps the install's mark of
// its own, as earlier CLIs did, which a new sign-in to the install starts
// anew, since the new login may be another user's.

/** Whose mark: the install's URL and, when the login names them, the user's id. */
export interface MarkOwner {
  readonly url: string;
  readonly userId?: string | undefined;
}

/** The file's contents: each install's marks, by the install's URL: the one of a login that names no user, and each user's, by id. */
interface AnnouncedFile {
  installs: Record<string, { through?: number; users?: Record<string, { through: number }> }>;
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

/** A mark's number as the file holds it; 0 for none. */
function numberOf(through: unknown): number {
  return typeof through === "number" && Number.isSafeInteger(through) && through > 0 ? through : 0;
}

/** The mark in these contents: the number of the last update announced to this owner; 0 before the first. */
function markIn(contents: AnnouncedFile, owner: MarkOwner): number {
  const install = contents.installs[owner.url];
  return numberOf(owner.userId === undefined ? install?.through : install?.users?.[owner.userId]?.through);
}

/** The number of the last update announced to this user of the install, or to its login that names no user; 0 before the first. */
export function announcedThrough(configDir: string, owner: MarkOwner): number {
  return markIn(read(configDir), owner);
}

/**
 * Announces what `choose` picks from the updates the mark does not hold: under
 * the lock, it gives `choose` the owner's mark, and moves the mark up to the
 * number `choose` answers, never back, before it returns what `choose` picked.
 * Nothing is picked, and nothing moves, when `choose` answers undefined.
 */
export function announce<T>(configDir: string, owner: MarkOwner, choose: (through: number) => { through: number; picked: T } | undefined): Promise<T | undefined> {
  return withFileLock(configDir, "announced.lock", pause, async () => {
    const contents = read(configDir);
    const through = markIn(contents, owner);
    const chosen = choose(through);
    if (chosen === undefined) return undefined;
    if (chosen.through > through) {
      const install = { ...contents.installs[owner.url] };
      if (owner.userId === undefined) install.through = chosen.through;
      else install.users = { ...install.users, [owner.userId]: { through: chosen.through } };
      contents.installs[owner.url] = install;
      write(configDir, contents);
    }
    return chosen.picked;
  });
}

/** Forgets the install's mark of a login that names no user, as a new sign-in to it does; every user's own mark stays. */
export function forgetAnnounced(configDir: string, url: string): Promise<void> {
  return withFileLock(configDir, "announced.lock", pause, async () => {
    const contents = read(configDir);
    const install = contents.installs[url];
    if (install === undefined || !Object.hasOwn(install, "through")) return;
    const { through: _forgotten, ...kept } = install;
    if (Object.keys(kept).length === 0) delete contents.installs[url];
    else contents.installs[url] = kept;
    write(configDir, contents);
  });
}
