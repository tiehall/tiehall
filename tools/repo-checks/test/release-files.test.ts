import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentedCommand } from "../src/docs-commands.ts";
import { KEPT_ASSET_NAME, RELEASE_FILES, RELEASE_NOTES_ASSET, stageReleaseFiles } from "../src/release-files.ts";

// The files a release publishes beside its image (self-host-install: Releases
// carry signed attestations): compose.yaml, the Caddyfile, .env.example,
// backup.sh and restore.sh, and the release notes. GitHub renames a release
// file whose name starts with a period, so .env.example is published as
// env.example, and the install docs' download command, run here against the
// staged files as a release page serves them, saves each under its own name.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const stage = fileURLToPath(new URL("../src/stage-release-files.ts", import.meta.url));

describe("the release files", () => {
  it("are compose.yaml, the Caddyfile, .env.example, backup.sh and restore.sh, from deploy/", () => {
    expect(RELEASE_FILES.map(({ name }) => name)).toEqual(["compose.yaml", "Caddyfile", ".env.example", "backup.sh", "restore.sh"]);
    for (const { source, name } of RELEASE_FILES) expect(source).toBe(`deploy/${name}`);
  });

  it("each have a name on the release page that GitHub keeps as it is, as the release notes do", () => {
    for (const asset of [...RELEASE_FILES.map(({ asset }) => asset), RELEASE_NOTES_ASSET]) expect(asset, asset).toMatch(KEPT_ASSET_NAME);
    expect(".env.example").not.toMatch(KEPT_ASSET_NAME);
    expect(RELEASE_FILES.find(({ name }) => name === ".env.example")?.asset).toBe("env.example");
  });
});

describe("staging the release files", () => {
  let folder: string;
  let server: Server;
  let address: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "tiehall-release-files-"));
    const run = spawnSync(process.execPath, [stage, join(folder, "release")], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // A release page's files, served by their asset names.
    server = createServer((incoming, outgoing) => {
      const name = (incoming.url ?? "").replace(/^\//, "");
      if (!readdirSync(join(folder, "release")).includes(name)) outgoing.writeHead(404).end();
      else outgoing.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(join(folder, "release", name)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    address = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  });

  it("copies each file under its asset name, the scripts executable and nothing else", () => {
    const staged = join(folder, "release");
    expect(readdirSync(staged).sort()).toEqual(RELEASE_FILES.map(({ asset }) => asset).sort());
    for (const { asset, source, executable } of RELEASE_FILES) {
      expect(readFileSync(join(staged, asset), "utf8"), asset).toBe(readFileSync(join(root, source), "utf8"));
      expect(statSync(join(staged, asset)).mode & 0o777, asset).toBe(executable ? 0o755 : 0o644);
    }
  });

  it("gives files that the install docs' download command saves under their own names, as deploy/ holds them", async () => {
    const install = join(folder, "install");
    mkdirSync(install);
    const command = documentedCommand(root, "install-download", { "<release>": address });
    // Run without blocking this process, which serves the files.
    const run = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", ["-c", command], { cwd: install, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readdirSync(install).sort()).toEqual(RELEASE_FILES.map(({ name }) => name).sort());
    for (const { name, source, executable } of RELEASE_FILES) {
      expect(readFileSync(join(install, name), "utf8"), name).toBe(readFileSync(join(root, source), "utf8"));
      if (executable) expect(statSync(join(install, name)).mode & 0o100, name).toBe(0o100);
    }
  });

  it("refuses a repository that lacks one of the files", () => {
    const empty = mkdtempSync(join(tmpdir(), "tiehall-release-files-empty-"));
    expect(() => stageReleaseFiles(empty, join(empty, "release"))).toThrow("The release file deploy/compose.yaml is missing.");
    rmSync(empty, { recursive: true, force: true });
  });
});

// The release notes reach the job that publishes the release as a workflow
// artifact written by a job that runs the repository's dependencies, whose
// code could put anything in it: a forged compose.yaml beside the notes, or a
// folder or a link in their place. The notes are staged only from a folder
// that holds release-notes.md alone, as a regular file, into a staging folder
// that held nothing, so the release publishes the operator files from the
// tag's own commit and nothing else beside the notes.
describe("staging the release notes", () => {
  let folder: string;
  const notesText = "# Tiehall 1.3.0\n\nThe notes.\n";
  /** A folder the notes artifact was downloaded into, holding the given files and folders. */
  const notesFolder = (name: string, files: Record<string, string>, folders: string[] = []): string => {
    const notes = join(folder, name);
    mkdirSync(notes);
    for (const each of folders) mkdirSync(join(notes, each), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(notes, file), text);
    return notes;
  };
  const stageWith = (release: string, notes: string) => spawnSync(process.execPath, [stage, release, "--notes", notes], { cwd: root, encoding: "utf8" });

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tiehall-release-notes-"));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("copies the notes beside the release files when their folder holds them alone, as a regular file", () => {
    const release = join(folder, "release");
    const run = stageWith(release, notesFolder("notes", { [RELEASE_NOTES_ASSET]: notesText }));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Staged 6 release files");
    expect(readdirSync(release).sort()).toEqual([...RELEASE_FILES.map(({ asset }) => asset), RELEASE_NOTES_ASSET].sort());
    expect(readFileSync(join(release, RELEASE_NOTES_ASSET), "utf8")).toBe(notesText);
    expect(statSync(join(release, RELEASE_NOTES_ASSET)).mode & 0o777).toBe(0o644);
    for (const { asset, source } of RELEASE_FILES) expect(readFileSync(join(release, asset), "utf8"), asset).toBe(readFileSync(join(root, source), "utf8"));
  });

  it("refuses notes that come with other files, such as a forged compose.yaml, and stages nothing", () => {
    const release = join(folder, "release-forged");
    const run = stageWith(release, notesFolder("notes-forged", { [RELEASE_NOTES_ASSET]: notesText, "compose.yaml": "services: {}\n" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`must hold only ${RELEASE_NOTES_ASSET}`);
    expect(run.stderr).toContain("compose.yaml");
    expect(statSync(release, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses notes that are a folder, a link or missing", () => {
    // A folder in the notes' place, whose files would otherwise be published beside the notes.
    const asFolder = notesFolder("notes-folder", { [`${RELEASE_NOTES_ASSET}/compose.yaml`]: "services: {}\n" }, [RELEASE_NOTES_ASSET]);
    const linked = notesFolder("notes-link", {});
    writeFileSync(join(folder, "elsewhere.md"), notesText);
    symlinkSync(join(folder, "elsewhere.md"), join(linked, RELEASE_NOTES_ASSET));
    for (const [name, notes] of [["folder", asFolder], ["link", linked]] as const) {
      const run = stageWith(join(folder, `release-${name}`), notes);
      expect(run.status, name).toBe(1);
      expect(run.stderr, name).toContain(`${RELEASE_NOTES_ASSET} in ${notes} is not a regular file.`);
      expect(statSync(join(folder, `release-${name}`), { throwIfNoEntry: false }), name).toBeUndefined();
    }
    for (const [name, notes] of [["empty", notesFolder("notes-empty", {})], ["missing", join(folder, "no-notes")]] as const) {
      const run = stageWith(join(folder, `release-${name}`), notes);
      expect(run.status, name).toBe(1);
      expect(run.stderr, name).toContain(`must hold only ${RELEASE_NOTES_ASSET}`);
    }
  });

  it("refuses a staging folder that already holds files, which would be published with the release", () => {
    const release = join(folder, "release-used");
    mkdirSync(release);
    writeFileSync(join(release, "compose.yaml"), "services: {}\n");
    const run = stageWith(release, notesFolder("notes-used", { [RELEASE_NOTES_ASSET]: notesText }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`The folder ${release} already holds files`);
    expect(readFileSync(join(release, "compose.yaml"), "utf8")).toBe("services: {}\n");
  });
});
