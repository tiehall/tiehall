import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The pinned, checksum-verified oasdiff (design.md, Technical decisions: T12;
// public-api: Notice before a breaking change is enforced in CI). CI and the
// tests run one oasdiff release, pinned in tools/repo-checks/oasdiff.json with
// the SHA-256 of each release archive. The archive is downloaded from the
// release on GitHub and its digest checked before anything in it runs; the
// binary is kept in node_modules/.cache, outside the repository's tracked
// files. oasdiff runs only here and in the providers' CI, never on the server.

const PIN = JSON.parse(readFileSync(new URL("../oasdiff.json", import.meta.url), "utf8")) as {
  version: string;
  archives: Record<string, { file: string; sha256: string }>;
};

export const OASDIFF_VERSION = PIN.version;

const CACHE = fileURLToPath(new URL(`../../../node_modules/.cache/tiehall-oasdiff/${PIN.version}/`, import.meta.url));

/** The path of the pinned oasdiff, downloaded and verified on first use. */
export async function oasdiff(): Promise<string> {
  const binary = join(CACHE, "oasdiff");
  if (existsSync(binary)) return binary;
  const platform = `${process.platform}-${process.arch}`;
  const archive = PIN.archives[platform];
  if (archive === undefined) throw new Error(`No oasdiff ${PIN.version} archive is pinned for ${platform}.`);
  const url = `https://github.com/oasdiff/oasdiff/releases/download/v${PIN.version}/${archive.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed with ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  checkArchive(archive.file, bytes, archive.sha256);
  mkdirSync(CACHE, { recursive: true });
  const work = mkdtempSync(join(CACHE, "extract-"));
  try {
    writeFileSync(join(work, archive.file), bytes);
    const tar = spawnSync("tar", ["-xzf", join(work, archive.file), "-C", work, "oasdiff"], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Extracting ${archive.file} failed: ${tar.stderr}`);
    chmodSync(join(work, "oasdiff"), 0o755);
    renameSync(join(work, "oasdiff"), binary);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return binary;
}

/** Refuses an archive whose SHA-256 is not the pinned one, before anything in it is extracted or run. */
export function checkArchive(file: string, bytes: Uint8Array, sha256: string): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) throw new Error(`${file} has the SHA-256 ${digest}, not the pinned ${sha256}; nothing from it was run.`);
}

const WORK = fileURLToPath(new URL("../../../node_modules/.cache/tiehall-oasdiff/work/", import.meta.url));

/**
 * Runs the pinned oasdiff on two documents, given as JSON text, which it reads
 * as base.json and revision.json in a folder of its own, beside any other
 * files the run needs; external $refs are off, so it reads nothing else, and
 * no configuration file of the repository applies.
 */
export async function runOnDocuments(
  args: readonly string[],
  base: string,
  revision: string,
  files: Readonly<Record<string, string>> = {},
): Promise<SpawnSyncReturns<string>> {
  const binary = await oasdiff();
  mkdirSync(WORK, { recursive: true });
  const folder = mkdtempSync(join(WORK, "run-"));
  try {
    writeFileSync(join(folder, "base.json"), base);
    writeFileSync(join(folder, "revision.json"), revision);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
    const run = spawnSync(binary, [...args.slice(0, 1), "base.json", "revision.json", ...args.slice(1), "--allow-external-refs=false"], {
      cwd: folder,
      encoding: "utf8",
    });
    if (run.error) throw run.error;
    return run;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
