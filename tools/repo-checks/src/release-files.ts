import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The files a release publishes beside its image (self-host-install: Releases
// carry signed attestations; design.md, Technical decisions: T13):
// compose.yaml, the Caddyfile, .env.example, backup.sh and restore.sh, from
// deploy/, and the release notes. The release workflow uploads each to the
// release page under its asset name, which is its own name but for
// .env.example: GitHub renames a release file whose name starts with a
// period (".env.example" becomes "default.env.example"), so the release names
// it env.example, and the install docs' download command saves it as
// .env.example. This list is the one the release workflow stages, the release
// notes name and the fresh-install test serves.

export interface ReleaseFile {
  /** The file's name on the release page, which GitHub keeps as it is. */
  asset: string;
  /** The file in the repository, relative to its root. */
  source: string;
  /** The name an install's folder holds it under, once downloaded. */
  name: string;
  /** Whether the operator runs it, so it keeps its executable bit when staged. */
  executable: boolean;
}

export const RELEASE_FILES: readonly ReleaseFile[] = [
  { asset: "compose.yaml", source: "deploy/compose.yaml", name: "compose.yaml", executable: false },
  { asset: "Caddyfile", source: "deploy/Caddyfile", name: "Caddyfile", executable: false },
  { asset: "env.example", source: "deploy/.env.example", name: ".env.example", executable: false },
  { asset: "backup.sh", source: "deploy/backup.sh", name: "backup.sh", executable: true },
  { asset: "restore.sh", source: "deploy/restore.sh", name: "restore.sh", executable: true },
];

/** The asset name of the release notes, which the release page also shows as its text. */
export const RELEASE_NOTES_ASSET = "release-notes.md";

/**
 * A name GitHub keeps for a release file: letters, digits, periods, hyphens
 * and underscores, starting and ending with a letter or a digit.
 */
export const KEPT_ASSET_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Copies the release files from the repository at root into folder, under their asset names; returns their paths. */
export function stageReleaseFiles(root: string, folder: string): string[] {
  mkdirSync(folder, { recursive: true });
  return RELEASE_FILES.map(({ asset, source, executable }) => {
    const from = join(root, source);
    if (!statSync(from, { throwIfNoEntry: false })?.isFile()) throw new Error(`The release file ${source} is missing.`);
    const to = join(folder, asset);
    copyFileSync(from, to);
    chmodSync(to, executable ? 0o755 : 0o644);
    return to;
  });
}
