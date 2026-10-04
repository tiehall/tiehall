import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previousRelease, readReleaseTag, releaseOf } from "../src/release-tag.ts";

// The version tag a release is made from (self-host-install: Releases carry
// signed attestations; self-host-install: Upgrades apply migrations before
// the app starts): a semantic version, from a commit of main, whose previous
// release is the newest final release older than it that the commit holds.
// The release workflow's first job runs the script on the tag it was started
// for; here it runs on a repository of the test's own.

const script = fileURLToPath(new URL("../src/read-release-tag.ts", import.meta.url));

describe("a version tag", () => {
  it("names a release, or a release candidate", () => {
    expect(readReleaseTag("v1.3.0")).toEqual({ tag: "v1.3.0", version: "1.3.0", prerelease: false });
    expect(readReleaseTag("v0.1.0")).toEqual({ tag: "v0.1.0", version: "0.1.0", prerelease: false });
    expect(readReleaseTag("v1.3.0-rc.1")).toEqual({ tag: "v1.3.0-rc.1", version: "1.3.0-rc.1", prerelease: true });
  });

  it("is refused when it names no semantic version, has leading zeros or carries build metadata, which an image tag cannot hold", () => {
    for (const tag of ["1.3.0", "v1.3", "v1.3.0.1", "v01.3.0", "v1.3.0+build.5", "v1.3.0-", "v1.3.0-rc..1", "release-1.3.0", "v1.3.0 "]) {
      expect(() => readReleaseTag(tag), tag).toThrow(/is no version tag/);
    }
  });
});

describe("the previous release", () => {
  it("is the newest final release older than the release, whatever the order of the tags", () => {
    const tags = ["v1.0.0", "v1.2.0", "v1.10.0", "v1.3.0-rc.1", "v1.1.0", "v2.0.0"];
    expect(previousRelease("1.3.0", tags)).toBe("v1.2.0");
    expect(previousRelease("1.11.0", tags)).toBe("v1.10.0");
    expect(previousRelease("1.3.0-rc.2", tags)).toBe("v1.2.0");
  });

  it("is never the release itself or a release candidate, and there is none before the first release", () => {
    expect(previousRelease("1.3.0", ["v1.3.0", "v1.3.0-rc.1", "v1.3.0-rc.2"])).toBeUndefined();
    expect(previousRelease("1.0.0", [])).toBeUndefined();
    expect(previousRelease("1.0.0", ["v0.9.0", "nightly", "v0.9"])).toBe("v0.9.0");
  });
});

describe("the release workflow's reading of its tag", () => {
  let repo: string;
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const commit = (message: string) => {
    writeFileSync(join(repo, "file.txt"), message);
    git("add", "file.txt");
    git("commit", "--quiet", "--message", message);
  };
  const read = (tag: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script, tag, "--main", "main", "--root", repo], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", ...env } });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tiehall-release-tag-"));
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "maintainers@example.com");
    git("config", "user.name", "Maintainers");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    commit("one");
    git("tag", "v1.0.0");
    commit("two");
    git("tag", "v1.1.0-rc.1");
    commit("three");
    git("tag", "v1.1.0");
    commit("four");
    git("tag", "v1.2.0-rc.1");
    git("tag", "not-a-version");
    git("switch", "--quiet", "--create", "side");
    commit("five, on a branch");
    git("tag", "v1.2.0");
    git("switch", "--quiet", "main");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("prints the version, whether it is a release candidate, and the previous release", () => {
    const run = read("v1.2.0-rc.1");
    expect(run.stderr).toContain("the previous release is v1.1.0");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("version=1.2.0-rc.1\nprerelease=true\nprevious=v1.1.0\n");
    expect(read("v1.1.0").stdout).toBe("version=1.1.0\nprerelease=false\nprevious=v1.0.0\n");
    expect(releaseOf(repo, "v1.0.0", "main")).toEqual({ tag: "v1.0.0", version: "1.0.0", prerelease: false, previous: undefined });
  });

  it("writes them into the step's outputs when the workflow gives a file for them", () => {
    const output = join(repo, "..", `${repo.split("/").pop()}-output`);
    writeFileSync(output, "earlier=1\n");
    const run = read("v1.0.0", { GITHUB_OUTPUT: output });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(readFileSync(output, "utf8")).toBe("earlier=1\nversion=1.0.0\nprerelease=false\nprevious=\n");
    rmSync(output);
  });

  it("refuses a tag on a commit that is not on main, a tag the repository does not hold, and a tag that is no version", () => {
    const branch = read("v1.2.0");
    expect(branch.status).toBe(1);
    expect(branch.stderr).toMatch(/The tag v1\.2\.0 points to [0-9a-f]{40}, which is not on main\. A release is made only from a commit of main\./);
    expect(branch.stdout).toBe("");
    const missing = read("v9.9.9");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("The repository holds no tag v9.9.9.");
    const other = read("not-a-version");
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("is no version tag");
  });
});
