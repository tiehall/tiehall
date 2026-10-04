import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The images the image checks test when the release workflow calls them
// (self-host-install: Upgrades apply migrations before the app starts): the
// release's own image, which the workflow built and saved, and, for the
// upgrade and backup tests, the previous release's image, the newest final
// release the parent of the release's commit holds, a release candidate being
// no release. The scripts run here with a stand-in for docker on the PATH,
// which records what it is asked and pulls only the images the test names.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const getImage = join(root, "tools/image-tests/get-image.sh");
const getPreviousImage = join(root, "tools/image-tests/get-previous-image.sh");

let folder: string;
let repo: string;
let bin: string;

/** Runs a script with the stand-in docker, which pulls only the images listed in PULLABLE. */
function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, GITHUB_REPOSITORY_OWNER: "Acme", DOCKER_LOG: join(folder, "docker.log"), PULLABLE: "", ...env },
  });
}

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "tiehall-release-images-"));
  bin = join(folder, "bin");
  repo = join(folder, "repo");
  spawnSync("mkdir", [bin, repo]);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$DOCKER_LOG"',
      'case "$1" in',
      '  load) echo "Loaded image: ghcr.io/acme/tiehall:1.3.0" ;;',
      '  pull) for image in $PULLABLE; do [ "$image" = "${@: -1}" ] && exit 0; done; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "maintainers@example.com");
  git("config", "user.name", "Maintainers");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  for (const [message, tag] of [["one", "v1.1.0"], ["two", "v1.2.0"], ["three", "v1.3.0-rc.1"], ["four", "v1.3.0"]] as const) {
    writeFileSync(join(repo, "file.txt"), message);
    git("add", "file.txt");
    git("commit", "--quiet", "--message", message);
    git("tag", tag);
  }
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("the image the release workflow's image checks test", () => {
  it("is the image it saved, loaded and tested by the name it was saved with", () => {
    const result = run(getImage, [], { IMAGE_ARCHIVE: join(folder, "image.tar") });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("TIEHALL_IMAGE=ghcr.io/acme/tiehall:1.3.0\n");
    expect(readFileSync(join(folder, "docker.log"), "utf8")).toBe(`load --input ${join(folder, "image.tar")}\n`);
  });
});

describe("the previous release's image", () => {
  it("is that of the newest final release the parent of the release's commit holds, a release candidate being none", () => {
    const result = run(getPreviousImage, ["HEAD^"], { PULLABLE: "ghcr.io/acme/tiehall:1.2.0 ghcr.io/acme/tiehall:1.3.0-rc.1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("TIEHALL_PREVIOUS_IMAGE=ghcr.io/acme/tiehall:1.2.0\n");
  });

  it("is never the release's own image, and the script says which image it could not pull", () => {
    const result = run(getPreviousImage, [`${git("rev-parse", "v1.3.0")}^`], { PULLABLE: "ghcr.io/acme/tiehall:1.3.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No previous image found: none of ghcr.io/acme/tiehall:1.2.0 could be pulled.");
  });
});
