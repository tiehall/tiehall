import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangelogRelease } from "@tiehall/catalog/changelog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentedCommand } from "../src/docs-commands.ts";
import { installCommands, installCommandsWithoutImage } from "../src/install-commands.ts";
import { parseReleaseImage, renderReleaseNotes } from "../src/release-notes.ts";

// The release notes (self-host-install: Releases carry signed attestations;
// self-host-install: `init` prints a complete `.env`; public-api: The
// changelog page and the release notes; self-host-install: Migrations
// expand, then contract; self-host-install: Upgrades apply migrations before
// the app starts): they name the image digest and the version tag, show how
// to check the image's attestations, list the files the release offers, show
// the install docs' commands with the release's own values, the install
// command with --image and the release's reference pinned by version and
// digest; and they carry the release's API changelog entries, flag its
// contract steps and name every release up to it that must not be skipped.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/write-release-notes.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/release-notes/", import.meta.url));
const digest = `sha256:${"a1".repeat(32)}`;
const reference = `ghcr.io/acme/tiehall:1.3.0@${digest}`;
const repository = "https://github.com/acme/tiehall";
/** The commit the release's tag points to. */
const commit = "0123456789abcdef0123456789abcdef01234567";
/** A release that changed nothing in the API. */
const unchanged = (version: string): ChangelogRelease => ({ version, date: "2026-11-02", apiVersion: "0.3.0", entries: [], changes: [] });

const notes = renderReleaseNotes({
  root,
  version: "1.3.0",
  image: parseReleaseImage(reference, "1.3.0"),
  repository,
  commit,
  api: unchanged("1.3.0"),
  contractSteps: [],
  noSkip: [],
});
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

  // contract-changes: The contract Action; public-api: Client pieces are built from public source with provenance.
  it("pin the contract Action to the release's commit by its full SHA, with the release's tag as a comment", () => {
    expect(notes).toContain("## The contract Action");
    expect(notes).toContain(["```yaml", `- uses: acme/tiehall/actions/contract@${commit} # v1.3.0`, "```"].join("\n"));
    expect(flat).toContain("Renovate and Dependabot");
    expect(notes).toContain(`${repository}/blob/v1.3.0/actions/contract/README.md`);
  });

  // agent-surfaces: The Claude Code plugin.
  it("show how to install the release's Claude Code plugin from the repository's marketplace, at the release's tag", () => {
    const manifest = JSON.parse(readFileSync(join(root, "packages/claude-plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
    expect(notes).toContain("## The Claude Code plugin");
    expect(flat).toContain(`the Claude Code plugin tiehall ${manifest.version}`);
    expect(notes).toContain(["```sh", "claude plugin marketplace add acme/tiehall#v1.3.0", "claude plugin install tiehall@tiehall", "```"].join("\n"));
    expect(notes).toContain(`${repository}/blob/v1.3.0/docs/claude-code-plugin.md`);
  });

  it("say that a release candidate is one", () => {
    const candidate = renderReleaseNotes({
      root,
      version: "1.3.0-rc.1",
      image: parseReleaseImage(`ghcr.io/acme/tiehall:1.3.0-rc.1@${digest}`, "1.3.0-rc.1"),
      repository,
      commit,
      api: unchanged("1.3.0-rc.1"),
      contractSteps: [],
      noSkip: [],
    });
    expect(candidate.split("\n")[0]).toBe("# Tiehall 1.3.0-rc.1");
    expect(candidate.replace(/\s+/g, " ")).toContain("This is a release candidate of 1.3.0");
    expect(flat).not.toContain("release candidate");
  });

  it("say that no release must be skipped and that the release has no contract step, and carry its API changes", () => {
    expect(flat).toContain("No release must be skipped: an install on any earlier release upgrades straight to this one, because the migrations run in order.");
    expect(flat).toContain("This release has no contract step");
    expect(notes).toContain("## API changes");
    expect(notes).toContain("No change to the API.");
  });
});

describe("the notes of a release with a deprecation, a contract step and a release that must not be skipped", () => {
  // A repository of the test's own: release 1.3.0 added a title, and 1.4.0 drops the name it replaced, deprecates
  // requests.list and adds an optional field; release 1.3.0 must not be skipped.
  let repo: string;
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  };
  const write = (version: string, ...options: string[]) =>
    spawnSync(process.execPath, [script, version, "--root", repo, ...options], { cwd: root, encoding: "utf8" });
  const image = `ghcr.io/acme/tiehall:1.4.0@${digest}`;
  let fixtureNotes = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tiehall-release-notes-repo-"));
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "maintainers@example.com");
    git("config", "user.name", "Maintainers");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    mkdirSync(join(repo, "docs"));
    cpSync(join(root, "docs/install.md"), join(repo, "docs/install.md"));
    // The release's Claude Code plugin and the marketplace that lists it, which the notes name.
    cpSync(join(root, ".claude-plugin"), join(repo, ".claude-plugin"), { recursive: true });
    cpSync(join(root, "packages/claude-plugin"), join(repo, "packages/claude-plugin"), { recursive: true, filter: (source) => !source.includes("node_modules") });
    cpSync(join(fixtures, "previous"), repo, { recursive: true });
    git("add", "--all");
    git("commit", "--quiet", "--message", "Release 1.3.0");
    git("tag", "v1.3.0");
    cpSync(join(fixtures, "current"), repo, { recursive: true });
    git("add", "--all");
    git("commit", "--quiet", "--message", "Release 1.4.0");
    const run = write("1.4.0", "--previous", "v1.3.0", "--image", image, "--repository", repository, "--commit", commit);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    fixtureNotes = run.stdout;
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("carry the API changelog entries: the deprecation with its sunset date, the new optional field and the maintainers' note", () => {
    expect(fixtureNotes).toContain("## API changes");
    expect(fixtureNotes).toContain("- `GET /api/v1/requests` (requests.list): endpoint deprecated with sunset date `2026-12-15` (stability: beta)");
    expect(fixtureNotes).toContain("- `GET /api/v1/requests/{key}` (requests.get): added the optional property `title` to the response with the `200` status");
    expect(fixtureNotes).toContain("- Note (requests.list): requests.list is deprecated: read a team's requests with its search operation instead.");
  });

  it("flag the contract step the release adds since the previous release, and the way back after it", () => {
    const text = fixtureNotes.replace(/\s+/g, " ");
    expect(text).toContain("This release has a contract step, which removes or rewrites what an earlier release replaced:");
    expect(fixtureNotes).toContain("- `0002_drop_name`, after the expand step of 1.3.0\n");
    expect(fixtureNotes).not.toContain("0001_add_title`");
    expect(fixtureNotes).not.toContain("0003_add_kind`");
    expect(text).toContain("Once it has run, an image of an earlier release no longer starts on the install's database: the way back is the backup taken before the upgrade, restored with the previous image");
    expect(text).toContain(`[rollback docs](${repository}/blob/v1.4.0/docs/install.md#rollback)`);
  });

  it("name the release that must not be skipped, with the maintainers' reason, and no later one", () => {
    const text = fixtureNotes.replace(/\s+/g, " ");
    expect(text).toContain("Release 1.3.0 must not be skipped: Its worker copies each thing's name into its title, which the contract step of 1.4.0 relies on. An install on a release before 1.3.0 upgrades to 1.3.0 first, and to this release after it.");
    expect(fixtureNotes).not.toContain("1.5.0");
    expect(text).not.toContain("No release must be skipped");
  });

  it("put the release's own no-skip note in its notes, worded for itself", () => {
    const own = renderReleaseNotes({
      root,
      version: "1.3.0",
      image: parseReleaseImage(reference, "1.3.0"),
      repository,
      commit,
      api: unchanged("1.3.0"),
      contractSteps: [],
      noSkip: [{ version: "1.3.0", reason: "Its worker moves the jobs of the old queue." }],
    }).replace(/\s+/g, " ");
    expect(own).toContain("This release must not be skipped: Its worker moves the jobs of the old queue. An install upgrades to it before it upgrades to a later release.");
  });

  it("are written into a file when the release workflow names one", () => {
    const output = join(repo, "..", `${repo.split("/").pop()}-notes.md`);
    const run = write("1.4.0", "--previous", "v1.3.0", "--image", image, "--repository", repository, "--commit", commit, "--output", output);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(readFileSync(output, "utf8")).toBe(fixtureNotes);
    rmSync(output);
  });

  it("are checked before the image is built, which prints what the notes will hold", () => {
    const run = write("1.4.0", "--previous", "v1.3.0", "--check");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("The notes of 1.4.0 can be written: 2 API changes and 1 entry, 1 contract step, 1 release that must not be skipped.\n");
  });

  it("refuse a release the changelog does not record, or records with another API version than the release's document", () => {
    const missing = write("1.4.1", "--previous", "v1.3.0", "--check");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("openapi/changelog.json records no release 1.4.1: record it with pnpm changelog:release 1.4.1 --previous v1.3.0, and merge that, before tagging the release.");
    writeFileSync(join(repo, "openapi/v1.json"), JSON.stringify({ openapi: "3.1.0", info: { title: "Tiehall API", version: "0.4.0" }, paths: {} }));
    const stale = write("1.4.0", "--previous", "v1.3.0", "--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("openapi/changelog.json records release 1.4.0 with the API at version 0.3.0, but openapi/v1.json is at version 0.4.0");
    git("checkout", "--quiet", "--", "openapi/v1.json");
  });

  it("refuse a contract step in the first release, and one whose expand step is not in an earlier release", () => {
    const first = write("1.4.0", "--check");
    expect(first.status).toBe(1);
    expect(first.stderr).toContain("The migration 0002_drop_name is a contract step, and the first release can hold none");
    writeFileSync(join(repo, "packages/db/migrations/0002_drop_name.sql"), '-- migrate: contract after 1.4.0\nALTER TABLE "things" DROP COLUMN "name";\n');
    const early = write("1.4.0", "--previous", "v1.3.0", "--check");
    expect(early.status).toBe(1);
    expect(early.stderr).toContain("The migration 0002_drop_name is a contract step after the expand step of 1.4.0, which is not a release before this one: a contract step ships at least one release after its expand step, which v1.3.0, the previous release, must hold.");
    git("checkout", "--quiet", "--", "packages/db/migrations/0002_drop_name.sql");
  });

  it("refuse a list of releases that must not be skipped that is not well formed", () => {
    for (const [text, problem] of [
      ["[]", "release/no-skip.json holds an object with a list of releases"],
      [JSON.stringify({ releases: [{ version: "1.3", reason: "x" }] }), "release/no-skip.json: releases[0] names a release version, such as 1.3.0, and the reason in a sentence"],
      [JSON.stringify({ releases: [{ version: "1.3.0", reason: "" }] }), "release/no-skip.json: releases[0] names a release version, such as 1.3.0, and the reason in a sentence"],
      [JSON.stringify({ releases: [{ version: "1.3.0", reason: "x" }, { version: "1.3.0", reason: "y" }] }), "release/no-skip.json names release 1.3.0 twice"],
    ] as const) {
      writeFileSync(join(repo, "release/no-skip.json"), text);
      const run = write("1.4.0", "--previous", "v1.3.0", "--check");
      expect(run.status, text).toBe(1);
      expect(run.stderr, text).toContain(problem);
    }
    git("checkout", "--quiet", "--", "release/no-skip.json");
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
  it("refuses an image that is not the release's, and a repository that is no web address", () => {
    const wrong = spawnSync(process.execPath, [script, "1.3.0", "--image", `ghcr.io/acme/tiehall:1.2.0@${digest}`, "--repository", repository, "--commit", commit], { cwd: root, encoding: "utf8" });
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toMatch(/pinned by version and digest/);
    const address = spawnSync(process.execPath, [script, "1.3.0", "--image", reference, "--repository", "acme/tiehall", "--commit", commit], { cwd: root, encoding: "utf8" });
    expect(address.status).toBe(1);
    expect(address.stderr).toContain("The repository must be its web address, such as https://github.com/acme/tiehall.");
  });

  it("refuses notes without the release's commit, or with one that is not a full commit SHA", () => {
    const without = spawnSync(process.execPath, [script, "1.3.0", "--image", reference, "--repository", repository], { cwd: root, encoding: "utf8" });
    expect(without.status).toBe(2);
    expect(without.stderr).toContain("--commit <sha>");
    const short = spawnSync(process.execPath, [script, "1.3.0", "--image", reference, "--repository", repository, "--commit", "0123456"], { cwd: root, encoding: "utf8" });
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("The release's commit must be its full SHA, 40 lower-case hexadecimal digits, such as $GITHUB_SHA of the tag's run; \"0123456\" is not.");
  });
});
