// CI check of the paths the public repository holds (task 30.1; design.md,
// Decisions this change rests on: D38). It fails when a tracked file lies
// outside the allowlist of tools/repo-checks/public-paths.json, or when the
// repository's own .gitignore no longer ignores private/, where the planning
// material that stays out of the public repository lives (task 3.4). With
// --history it reads, instead of the tracked files, every path that a commit
// of any ref holds, which is how the history rewrite of task 30.3 is checked.
// It prints each path outside the allowlist alone on its own line on its
// standard output, and why on its standard error, so that the list can be
// handed to a history rewrite as the paths to remove:
//   node tools/repo-checks/src/check-public-paths.ts --history > outside.txt
// It uses only Node built-ins and git.
// Usage: node tools/repo-checks/src/check-public-paths.ts [root] [--history]
import { resolve } from "node:path";
import process from "node:process";
import { ALLOWLIST_PATH, foldersNotIgnored, historyPaths, loadPublicPaths, pathsOutside, topOfRepository, trackedFiles } from "./public-paths.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const history = args.includes("--history");
const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--history");
const folders = args.filter((arg) => !arg.startsWith("-"));
if (unknown.length > 0 || folders.length > 1) {
  console.error("Usage: node tools/repo-checks/src/check-public-paths.ts [root] [--history]");
  process.exit(2);
}

const folder = resolve(folders[0] ?? ".");
const top = topOfRepository(folder);
if (top === undefined) {
  console.error(`${folder} is not in a git repository, so the check could read no tracked file.`);
  process.exit(2);
}

const { patterns, ignored } = loadPublicPaths();
const paths = history ? historyPaths(top) : trackedFiles(top);
const outside = pathsOutside(paths, patterns);
const notIgnored = foldersNotIgnored(top, ignored);
const what = history ? "paths that commits of the repository's refs hold" : "tracked files";

for (const path of outside) console.log(path);
if (outside.length > 0) {
  console.error(
    `${outside.length} ${what} lie outside the allowlist of paths the public repository holds, ${ALLOWLIST_PATH}; ` +
      "each is printed above on a line of its own. Planning material stays in the git-ignored private/ folder (D38). " +
      "A file the public repository should hold needs a pattern in the allowlist, which a reviewer approves like any " +
      "change that makes more of the repository public." +
      (history ? " A path that only the history holds is removed by rewriting the history, never by a later commit." : ""),
  );
}
for (const ignoredFolder of notIgnored) {
  console.error(
    `${ignoredFolder} is not git-ignored by the repository's .gitignore, which must ignore it and everything in it, ` +
      "so that the planning material kept there on a maintainer's machine is never committed. This clone's own " +
      ".git/info/exclude and a user's own ignore file do not count, since no other clone holds them.",
  );
}

if (outside.length > 0 || notIgnored.length > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `All ${paths.length} ${what} lie within the allowlist of paths the public repository holds (${ALLOWLIST_PATH}), ` +
      `and ${ignored.join(", ")} ${ignored.length === 1 ? "is" : "are"} git-ignored by the repository's .gitignore.`,
  );
}
