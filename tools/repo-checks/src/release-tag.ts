import { execFileSync } from "node:child_process";
import { compareVersions } from "@tiehall/core";

// The version tag a release is made from (self-host-install: Releases carry
// signed attestations; self-host-install: Upgrades apply migrations before
// the app starts; design.md, Technical decisions: T13). Releases use semantic
// versions: a tag v<major>.<minor>.<patch> makes a release, and one with a
// pre-release, such as v1.3.0-rc.1, a release candidate, which the release
// page marks as a pre-release. The version is the image's version tag, so it
// carries no build metadata, which an image tag cannot hold. A release is
// built from a commit of main, whose pull requests were reviewed, never from a
// tag on another branch. Its previous release is the newest final release
// older than it among the version tags its commit holds.

/** A version tag: v and a semantic version without build metadata, such as v1.3.0 or v1.3.0-rc.1. */
export const VERSION_TAG = /^v((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/;

/** The tag of a final release, which names no pre-release. */
const FINAL_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export interface ReleaseTag {
  /** The tag, such as v1.3.0. */
  tag: string;
  /** The release's version, the tag without its v, such as 1.3.0; the image's version tag. */
  version: string;
  /** Whether it is a release candidate, such as 1.3.0-rc.1. */
  prerelease: boolean;
}

export interface Release extends ReleaseTag {
  /** The tag of the previous release, such as v1.2.0, or undefined for the first release. */
  previous: string | undefined;
}

/** The release a tag names; it throws, saying why, for a tag that is no version tag. */
export function readReleaseTag(tag: string): ReleaseTag {
  const match = VERSION_TAG.exec(tag);
  if (match === null || match[1] === undefined || match[1].length > 128) {
    throw new Error(
      `The tag ${JSON.stringify(tag)} is no version tag. A release is made from a tag v<major>.<minor>.<patch>, such as v1.3.0, ` +
        "or a release candidate such as v1.3.0-rc.1, without build metadata.",
    );
  }
  return { tag, version: match[1], prerelease: match[2] !== undefined };
}

/** The tag of the newest final release older than version among these tags, or undefined when there is none. */
export function previousRelease(version: string, tags: readonly string[]): string | undefined {
  return tags
    .filter((tag) => FINAL_RELEASE_TAG.test(tag) && VERSION_TAG.test(tag))
    .filter((tag) => compareVersions(tag.slice(1), version) < 0)
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0];
}

function git(root: string, args: readonly string[]): { status: number; stdout: string } {
  try {
    return { status: 0, stdout: execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? "" };
  }
}

/**
 * The release a tag makes in the repository at root: the tag must name a
 * version and the commit it points to must be on main; the previous release
 * is read from the version tags that commit holds.
 */
export function releaseOf(root: string, tag: string, main = "origin/main"): Release {
  const release = readReleaseTag(tag);
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (commit.status !== 0) throw new Error(`The repository holds no tag ${tag}.`);
  const sha = commit.stdout.trim();
  if (git(root, ["rev-parse", "--verify", "--quiet", `${main}^{commit}`]).status !== 0) {
    throw new Error(`The repository holds no ${main} to check the tag against; fetch its history.`);
  }
  if (git(root, ["merge-base", "--is-ancestor", sha, main]).status !== 0) {
    throw new Error(`The tag ${tag} points to ${sha}, which is not on ${main}. A release is made only from a commit of main.`);
  }
  const tags = git(root, ["tag", "--list", "v*", "--merged", sha]).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return { ...release, previous: previousRelease(release.version, tags) };
}
