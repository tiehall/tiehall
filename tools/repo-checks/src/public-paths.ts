import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The allowlist of paths the public repository holds (task 30.1; design.md,
// Decisions this change rests on: D38). tools/repo-checks/public-paths.json
// lists, in groups that say why, the patterns of the paths the public
// repository may hold, and the folders that must stay git-ignored: private/,
// where the planning material that stays out of the public repository lives
// (task 3.4). A pattern is a path from the repository's root in which `*`
// stands for any characters but a slash and `**`, a whole segment, for any
// number of folders; `folder/**` holds a folder and everything in it. A
// pattern that starts with `!` takes back what an earlier one allowed, and the
// last pattern that matches a path decides, as in a .gitignore.

export interface PublicPaths {
  /** The patterns, in the allowlist's order. */
  patterns: string[];
  /** The folders, each ending in a slash, that the repository's .gitignore must ignore. */
  ignored: string[];
}

export const ALLOWLIST_PATH = "tools/repo-checks/public-paths.json";

export function loadPublicPaths(): PublicPaths {
  const file = new URL("../public-paths.json", import.meta.url);
  const { paths, ignored } = JSON.parse(readFileSync(file, "utf8")) as { paths: Record<string, string[]>; ignored: string[] };
  const patterns = Object.entries(paths)
    .filter(([group]) => !group.startsWith("$"))
    .flatMap(([, list]) => list);
  // Each pattern is checked once, here, so a mistyped one stops the check instead of matching nothing.
  for (const pattern of patterns) patternRegExp(pattern.startsWith("!") ? pattern.slice(1) : pattern);
  return { patterns, ignored };
}

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** The regular expression a pattern stands for, matching a whole path; a pattern outside the allowlist's form throws. */
export function patternRegExp(pattern: string): RegExp {
  const refuse = (why: string) => new Error(`The pattern "${pattern}" ${why}.`);
  if (pattern === "") throw refuse("is empty");
  if (pattern.startsWith("/")) throw refuse("starts with a slash: a pattern is a path from the repository's root, without one");
  if (pattern.endsWith("/")) throw refuse("ends with a slash: a folder and everything in it is written folder/**");
  if (/[?[\]{}\\]/.test(pattern)) throw refuse("holds a wildcard other than * and **, or a backslash");
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "" || segment === "." || segment === "..") throw refuse("holds an empty segment, . or ..");
    if (segment === "**") {
      source += last ? "[^/].*" : "(?:[^/]+/)*";
      return;
    }
    if (segment.includes("**")) throw refuse("holds ** inside a segment, where it stands only as a whole one");
    source += segment.split("*").map(escape).join("[^/]*") + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`, "su");
}

/** Whether the allowlist's patterns hold a path: the last pattern that matches it decides. */
export function isPublic(path: string, patterns: readonly string[]): boolean {
  let holds = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (patternRegExp(negated ? pattern.slice(1) : pattern).test(path)) holds = !negated;
  }
  return holds;
}

/** The paths, sorted, that the patterns do not hold. */
export function pathsOutside(paths: Iterable<string>, patterns: readonly string[]): string[] {
  const compiled = patterns.map((pattern) =>
    pattern.startsWith("!") ? { negated: true, regExp: patternRegExp(pattern.slice(1)) } : { negated: false, regExp: patternRegExp(pattern) },
  );
  const holds = (path: string) => compiled.reduce((held, { negated, regExp }) => (regExp.test(path) ? !negated : held), false);
  return [...new Set(paths)].filter((path) => !holds(path)).sort();
}

function git(top: string, args: string[]): string {
  const run = spawnSync("git", args, { cwd: top, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

const nulSeparated = (output: string) => output.split("\0").filter((path) => path !== "");

/** The top folder of the git working tree that holds folder, or undefined when no repository holds it. */
export function topOfRepository(folder: string): string | undefined {
  const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return undefined;
  return run.stdout.trim();
}

/** The files git tracks, from the top of the working tree. */
export function trackedFiles(top: string): string[] {
  return nulSeparated(git(top, ["ls-files", "-z"]));
}

/**
 * Every path that a commit of any ref holds: every path a commit adds or
 * changes, the first commit and each side of a merge included, so that a path
 * that only a merge's resolution adds is listed too.
 */
export function historyPaths(top: string): string[] {
  return [
    ...new Set(nulSeparated(git(top, ["log", "--all", "--root", "--diff-merges=separate", "--no-renames", "--name-only", "--format=", "-z"]))),
  ];
}

/**
 * The folders, of those given, that the repository's own .gitignore does not
 * ignore: a folder and a file in it must each match a pattern of the root's
 * .gitignore that is not negated. This clone's info/exclude and the user's
 * own ignore file do not count, since no other clone holds them.
 */
export function foldersNotIgnored(top: string, folders: readonly string[]): string[] {
  return folders.filter((folder) => {
    const probes = [folder, `${folder}any/file.md`];
    const run = spawnSync("git", ["check-ignore", "--no-index", "--verbose", "--non-matching", "--stdin", "-z"], {
      cwd: top,
      encoding: "utf8",
      input: probes.map((probe) => `${probe}\0`).join(""),
    });
    if (run.error) throw run.error;
    // It exits with 1 when no probe is ignored, and with 128 on an error.
    if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed: ${run.stderr.trim()}`);
    // Each probe gives four fields, each ended by a NUL: the ignore file, its line, the pattern and the path, the
    // first three empty when no pattern matches.
    const fields = run.stdout.split("\0");
    return !probes.every((_probe, index) => fields[index * 4] === ".gitignore" && fields[index * 4 + 2]?.startsWith("!") === false);
  });
}
