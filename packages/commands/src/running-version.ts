import type { Environment } from "./settings.ts";

// The running version and the link to its source (self-host-install: The
// running version links to its source; design.md, Self-hosting decisions: S12
// and S16). The web UI's footer and the admin page show them, so that the
// people who use an install over the network are offered the source of the
// server they use, as the AGPL-3.0 asks of a server offered over a network.
//
// The image carries its release (TIEHALL_VERSION, which the release workflow
// sets from the version tag), the commit it was built from
// (TIEHALL_COMMIT_SHA) and the public repository it was built from
// (TIEHALL_SOURCE_REPOSITORY, which the build workflow sets from the
// repository it runs in). By default the link points to that release's
// source there, at its version tag, or, for a development build, which is no
// release, to its commit. An operator who runs a modified server sets
// TIEHALL_SOURCE_URL in .env to their own source, and the link points there.

/** The public Tiehall repository, for an image whose build named none, such as a local build. */
export const DEFAULT_SOURCE_REPOSITORY = "https://github.com/muhmmdcnkl/Tiehall";

/** The version a development build carries, which is no release. */
const DEVELOPMENT = /-dev$/;
/** A commit, as git names it in full or in short. */
const COMMIT = /^[0-9a-f]{7,40}$/;

export interface RunningVersion {
  /** The release, such as 1.3.0, or 0.0.0-dev for a development build. */
  version: string;
  /** Where the source of the running server is. */
  sourceUrl: string;
}

/** A setting's value, when it is set to something other than blanks. */
function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** An http(s) URL, or undefined for any other text. */
function webUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return /^https?:$/.test(new URL(value).protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The running version and the link to its source, from the image's own settings and TIEHALL_SOURCE_URL. */
export function runningVersion(env: Environment): RunningVersion {
  const version = setting(env, "TIEHALL_VERSION") ?? "0.0.0-dev";
  const own = webUrl(setting(env, "TIEHALL_SOURCE_URL"));
  if (own !== undefined) return { version, sourceUrl: own };
  const { repository, ref } = builtFrom(env);
  return { version, sourceUrl: ref === undefined ? repository : `${repository}/tree/${ref}` };
}

/**
 * The public repository the image was built from, and the ref of its source
 * there: the release's version tag, a development build's commit, or none for
 * a development build that names no commit. TIEHALL_SOURCE_URL plays no part.
 */
export function builtFrom(env: Environment): { repository: string; ref: string | undefined } {
  const version = setting(env, "TIEHALL_VERSION") ?? "0.0.0-dev";
  const repository = (webUrl(setting(env, "TIEHALL_SOURCE_REPOSITORY")) ?? DEFAULT_SOURCE_REPOSITORY).replace(/\/+$/, "");
  if (!DEVELOPMENT.test(version)) return { repository, ref: `v${version}` };
  const commit = setting(env, "TIEHALL_COMMIT_SHA");
  return { repository, ref: commit !== undefined && COMMIT.test(commit) ? commit : undefined };
}
