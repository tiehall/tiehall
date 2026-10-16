import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The text files the repository holds, as the checks of what a public
// repository may name read them (tasks 30.7 and 30.8): every file git tracks,
// and every new file it does not ignore, so that a check fails before the
// file is committed. A file that holds a NUL byte is binary and left out, and
// so is the lock file, whose names are packages and versions.

/** A file of the repository, by its path from the root, with its text. */
export interface TextFile {
  path: string;
  text: string;
}

/** The files that are never read as the repository's own text. */
const SKIPPED = new Set(["pnpm-lock.yaml"]);

/** The repository's text files under root, tracked or new and not ignored, in git's order. */
export function trackedTextFiles(root: string): TextFile[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(listed.split("\0").filter((path) => path !== ""))].flatMap((path) => {
    const file = join(root, path);
    if (SKIPPED.has(path) || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return [];
    const bytes = readFileSync(file);
    if (bytes.includes(0)) return [];
    return [{ path, text: bytes.toString("utf8") }];
  });
}

/** The line, from 1, that holds the character at this index of the text. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++;
  return line;
}
