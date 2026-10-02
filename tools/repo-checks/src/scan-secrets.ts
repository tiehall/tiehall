// CI secret scan for self-host-install: Release pipeline integrity. It runs
// gitleaks over every commit of a repository (all refs the checkout holds, so the whole
// pushed history and the commits of a pull request). gitleaks runs from its
// image pinned by digest, with no network, no capabilities, as nobody, and with
// the repository mounted read-only, so the scanner can neither change the
// checkout nor send anything out. Findings are redacted in the log.
// Usage: node tools/repo-checks/src/scan-secrets.ts [repo] [extra gitleaks options, e.g. --log-opts=HEAD]
// The repository is the current folder when the first argument is an option,
// as `pnpm run scan:secrets --log-opts=HEAD` passes it. gitleaks scans no
// commit and finds no leak in a folder whose history it cannot see, so the
// scan fails unless the folder is the top of a git repository that holds its
// own history: only the folder is mounted.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";

/** Renovate proposes new digests for this image after the 7-day release age (renovate.json). */
export const GITLEAKS_IMAGE =
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

const args = process.argv.slice(2);
const repoArgument = args[0]?.startsWith("-") === false ? args[0] : undefined;
const extra = repoArgument === undefined ? args : args.slice(1);
const repo = resolve(repoArgument ?? ".");

if (!holdsItsHistory(repo)) {
  console.error(
    `${repo} is not the top folder of a git repository whose history it holds, so the secret scan could read no commit. ` +
      "Name a repository's top folder, or run the scan from it.",
  );
  process.exit(1);
}

/** Whether the folder is the top of a git working tree whose git folder lies within it. */
function holdsItsHistory(folder: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: folder, encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const [top, gitDir] = probe.stdout.trim().split("\n");
  if (top === undefined || gitDir === undefined) return false;
  const real = realpathSync(folder);
  const inside = relative(real, realpathSync(gitDir));
  return realpathSync(top) === real && inside !== "" && !inside.startsWith("..");
}

const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    // The checkout belongs to another uid; trust it for this read-only scan.
    "--env=GIT_CONFIG_COUNT=1",
    "--env=GIT_CONFIG_KEY_0=safe.directory",
    "--env=GIT_CONFIG_VALUE_0=*",
    `--volume=${repo}:/repo:ro`,
    GITLEAKS_IMAGE,
    "git",
    "/repo",
    "--redact",
    "--verbose",
    "--no-banner",
    "--no-color",
    ...extra,
  ],
  { stdio: "inherit" },
);

if (run.error) throw run.error;
if (run.status !== 0) {
  console.error(
    "\nThe secret scan failed. A secret stays in the history after a later commit deletes it: rotate it first, " +
      "then rewrite the history of an unmerged branch, or record a reviewed false positive in .gitleaksignore.",
  );
}
process.exitCode = run.status ?? 1;
