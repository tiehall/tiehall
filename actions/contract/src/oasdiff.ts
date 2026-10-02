import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The pinned, checksum-verified diff engine (contract-changes: The contract
// Action; contract-changes: Contract diffs run only where the specs already
// are; design.md, Technical decisions: T12). The contract Action runs one
// oasdiff release, the one Tiehall's own CI runs, pinned in pins.json with the
// SHA-256 of each release archive. The archive is downloaded from the release
// on GitHub and its digest is checked before anything in it is extracted or
// run, so a binary that is not the pinned one never runs. oasdiff then runs on
// two documents in a folder of its own, with external $refs off, so it reads
// nothing else and fetches nothing, no configuration file of the repository
// applies, and it uploads nothing: Tiehall never runs it with --open.

/** The pinned oasdiff release: its version, and the archive of each platform with its SHA-256. */
export interface OasdiffPin {
  version: string;
  archives: Readonly<Record<string, { file: string; sha256: string }>>;
}

/** The oasdiff release the Action pins. */
export const OASDIFF: OasdiffPin = (JSON.parse(readFileSync(new URL("../pins.json", import.meta.url), "utf8")) as { oasdiff: OasdiffPin }).oasdiff;

/** An archive whose SHA-256 is not the pinned one: nothing from it was extracted or run. */
export class ChecksumError extends Error {
  override name = "ChecksumError";
}

/** A platform for which no archive is pinned. */
export class UnsupportedPlatformError extends Error {
  override name = "UnsupportedPlatformError";
}

/** Refuses an archive whose SHA-256 is not the pinned one, before anything in it is extracted or run. */
export function verifyArchive(file: string, bytes: Uint8Array, sha256: string): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) {
    throw new ChecksumError(`${file} has the SHA-256 ${digest}, not the pinned ${sha256}, so nothing from it was run.`);
  }
}

/** The release archive's URL on GitHub. */
export function archiveUrl(pin: OasdiffPin, file: string): string {
  return `https://github.com/oasdiff/oasdiff/releases/download/v${pin.version}/${file}`;
}

export interface InstallOptions {
  /** The folder the verified binary goes into, as `oasdiff`. */
  directory: string;
  /** Downloads the archive; the platform's fetch unless given. */
  fetch?: (request: Request) => Promise<Response>;
  /** The platform and processor, such as linux and x64; the process's unless given. */
  platform?: string;
  arch?: string;
  /** The pin; the Action's unless given. */
  pin?: OasdiffPin;
}

/**
 * Downloads the pinned oasdiff archive for this platform, checks its SHA-256,
 * and only then extracts the binary into the folder; returns the binary's
 * path. It throws ChecksumError for an archive that is not the pinned one,
 * having extracted and run nothing of it.
 */
export async function installOasdiff(options: InstallOptions): Promise<string> {
  const pin = options.pin ?? OASDIFF;
  const platform = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const archive = pin.archives[platform];
  if (archive === undefined) {
    throw new UnsupportedPlatformError(`No oasdiff ${pin.version} archive is pinned for ${platform}; the Action runs on Linux and macOS runners, on x64 and arm64.`);
  }
  const url = archiveUrl(pin, archive.file);
  const fetchOf = options.fetch ?? ((request: Request) => fetch(request));
  const response = await fetchOf(new Request(url));
  if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyArchive(archive.file, bytes, archive.sha256);
  mkdirSync(options.directory, { recursive: true });
  const work = mkdtempSync(join(options.directory, "extract-"));
  const binary = join(options.directory, "oasdiff");
  try {
    writeFileSync(join(work, archive.file), bytes);
    const tar = spawnSync("tar", ["-xzf", join(work, archive.file), "-C", work, "oasdiff"], { encoding: "utf8" });
    if (tar.error !== undefined || tar.status !== 0) throw new Error(`Extracting oasdiff from ${archive.file} failed.`);
    chmodSync(join(work, "oasdiff"), 0o755);
    renameSync(join(work, "oasdiff"), binary);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return binary;
}

/**
 * The pinned oasdiff in a cache folder, downloaded and verified on first use,
 * for the scripts and tests of this package; the Action itself installs it
 * anew in each run.
 */
export async function cachedOasdiff(cache: string, options: Omit<InstallOptions, "directory"> = {}): Promise<string> {
  const pin = options.pin ?? OASDIFF;
  const directory = join(cache, pin.version);
  const binary = join(directory, "oasdiff");
  if (existsSync(binary)) return binary;
  return installOasdiff({ ...options, directory });
}

/** The option every oasdiff run of the Action takes: no external $refs, so it reads and fetches nothing else. */
export const OASDIFF_OPTIONS: readonly string[] = ["--allow-external-refs=false"];

/** The arguments of `oasdiff breaking`, which lists the breaking changes, ERR and WARN, as text without colors. */
export function breakingArguments(base: string, revision: string): string[] {
  return ["breaking", base, revision, "--format", "text", "--color", "never", ...OASDIFF_OPTIONS];
}

/** The arguments of `oasdiff changelog --format json`, which classifies every change, ERR, WARN and INFO. */
export function changelogArguments(base: string, revision: string): string[] {
  return ["changelog", base, revision, "--format", "json", ...OASDIFF_OPTIONS];
}
