import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentedCommand } from "../src/docs-commands.ts";
import { installCommands, installCommandsWithoutImage } from "../src/install-commands.ts";
import { parseReleaseImage, renderReleaseNotes } from "../src/release-notes.ts";

// The release notes (self-host-install: Releases carry signed attestations;
// self-host-install: `init` prints a complete `.env`): they name the image
// digest and the version tag, show how to check the image's attestations,
// list the files the release offers, and show the install docs' commands
// with the release's own values, the install command with --image and the
// release's reference pinned by version and digest.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/write-release-notes.ts", import.meta.url));
const digest = `sha256:${"a1".repeat(32)}`;
const reference = `ghcr.io/acme/tiehall:1.3.0@${digest}`;
const repository = "https://github.com/acme/tiehall";

const notes = renderReleaseNotes({ root, version: "1.3.0", image: parseReleaseImage(reference, "1.3.0"), repository });
const flat = notes.replace(/\s+/g, " ");

describe("the release notes", () => {
  it("name the release, its image pinned by version and digest, the version tag and the digest", () => {
    expect(notes.split("\n")[0]).toBe("# Tiehall 1.3.0");
    expect(notes).toContain(`\`${reference}\``);
    expect(flat).toContain("version tag `ghcr.io/acme/tiehall:1.3.0`");
    expect(flat).toContain(`digest \`${digest}\``);
  });

  it("show how to check the image's build provenance and its SBOM against the repository, with no credentials", () => {
    const check = `gh attestation verify oci://ghcr.io/acme/tiehall@${digest} --repo acme/tiehall --signer-workflow acme/tiehall/.github/workflows/release.yml --source-ref refs/tags/v1.3.0 --bundle-from-oci`;
    expect(notes).toContain(`${check}\n`);
    expect(notes).toContain(`${check} --predicate-type https://spdx.dev/Document/v2.3\n`);
  });

  it("list the files the release offers, .env.example under the name the release page gives it", () => {
    for (const file of ["`compose.yaml`", "`Caddyfile`", "`backup.sh`", "`restore.sh`", "`release-notes.md`"]) expect(flat).toContain(file);
    expect(flat).toContain("`.env.example` (as `env.example`)");
    expect(flat).toContain("the download below saves it as `.env.example`");
  });

  it("show the install docs' commands with the release's address and its reference, the install command with --image", () => {
    const address = "https://github.com/acme/tiehall/releases/download/v1.3.0";
    expect(notes).toContain(documentedCommand(root, "install-download", { "<release>": address }));
    expect(notes).toContain(documentedCommand(root, "install-init", { "<image>": reference }));
    expect(notes).toContain(documentedCommand(root, "install-up"));
    expect(installCommands(notes)).toHaveLength(1);
    expect(installCommands(notes)[0]?.command).toContain(`docker run --rm ${reference} init --url https://tiehall.example.com --image ${reference}`);
    expect(installCommandsWithoutImage("release-notes.md", notes)).toEqual([]);
    expect(notes).toContain(`${repository}/blob/v1.3.0/docs/install.md`);
  });

  it("show the upgrade: a backup, the release's reference in TIEHALL_IMAGE, then the pull and the start", () => {
    expect(notes).toContain(documentedCommand(root, "upgrade-backup"));
    expect(notes).toContain(`TIEHALL_IMAGE=${reference}\n`);
    expect(notes).toContain(documentedCommand(root, "upgrade-pull-up"));
  });

  it("say that a release candidate is one", () => {
    const candidate = renderReleaseNotes({ root, version: "1.3.0-rc.1", image: parseReleaseImage(`ghcr.io/acme/tiehall:1.3.0-rc.1@${digest}`, "1.3.0-rc.1"), repository });
    expect(candidate.split("\n")[0]).toBe("# Tiehall 1.3.0-rc.1");
    expect(candidate.replace(/\s+/g, " ")).toContain("This is a release candidate of 1.3.0");
    expect(flat).not.toContain("release candidate");
  });
});

describe("the image a release names", () => {
  it("is its repository, tagged with the release's version and pinned by digest", () => {
    expect(parseReleaseImage(reference, "1.3.0")).toEqual({ repository: "ghcr.io/acme/tiehall", version: "1.3.0", digest });
  });

  it("is refused without a digest, with another tag, with a malformed digest or with a repository that is no image name", () => {
    expect(() => parseReleaseImage("ghcr.io/acme/tiehall:1.3.0", "1.3.0")).toThrow(/pinned by version and digest/);
    expect(() => parseReleaseImage(`ghcr.io/acme/tiehall:1.2.0@${digest}`, "1.3.0")).toThrow(/pinned by version and digest/);
    expect(() => parseReleaseImage(`ghcr.io/acme/tiehall@${digest}`, "1.3.0")).toThrow(/pinned by version and digest/);
    expect(() => parseReleaseImage("ghcr.io/acme/tiehall:1.3.0@sha256:abc", "1.3.0")).toThrow(/pinned by version and digest/);
    expect(() => parseReleaseImage(`ghcr.io/Acme/tiehall:1.3.0@${digest}`, "1.3.0")).toThrow(/pinned by version and digest/);
  });
});

describe("the release workflow's writing of the notes", () => {
  it("writes the notes for the release's image into a file", () => {
    const folder = mkdtempSync(join(tmpdir(), "tiehall-release-notes-"));
    const output = join(folder, "release-notes.md");
    const run = spawnSync(process.execPath, [script, "1.3.0", "--image", reference, "--repository", repository, "--output", output], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(notes);
    rmSync(folder, { recursive: true, force: true });
  });

  it("refuses an image that is not the release's, and a repository that is no web address", () => {
    const wrong = spawnSync(process.execPath, [script, "1.3.0", "--image", `ghcr.io/acme/tiehall:1.2.0@${digest}`, "--repository", repository], { cwd: root, encoding: "utf8" });
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toMatch(/pinned by version and digest/);
    const address = spawnSync(process.execPath, [script, "1.3.0", "--image", reference, "--repository", "acme/tiehall"], { cwd: root, encoding: "utf8" });
    expect(address.status).toBe(1);
    expect(address.stderr).toContain("The repository must be its web address, such as https://github.com/acme/tiehall.");
  });
});
