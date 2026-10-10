import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { packetPublication } from "../src/packet-publication.ts";
import { RELEASES_FOLDER } from "../src/packet-releases.ts";

// The CI workflow that publishes @tiehall/packet (handoff-packet: The npm
// package; public-api: Client pieces are built from public source with
// provenance; self-host-install: Release pipeline integrity; design.md,
// Technical decisions: T13). A job that can write nothing builds the package
// from this repository, checks its content and its validator, and packs it;
// the publish job then publishes that tarball, checked against the digest the
// build job gave, to npm with provenance through npm's trusted publishing,
// holding only the OIDC token permission and running only GitHub's own
// actions and npm itself, never a dependency's code. It stays off until the
// schema is published: a maintainer starts the workflow, and its build and
// publish jobs run only on main and only when the release-URL tree holds a
// release, whose version the package takes (handoff-packet: When the schema is
// published).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/read-packet-publication.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "tiehall-packet-publication-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}

const workflow = parse(readFileSync(join(root, ".github/workflows/packet-package.yml"), "utf8")) as { on: unknown; permissions: unknown; jobs: Record<string, Job> };
const prepare = workflow.jobs["prepare"] as Job;
const build = workflow.jobs["build"] as Job;
const publish = workflow.jobs["publish"] as Job;
const runs = (job: Job) => (job.steps ?? []).map(({ run }) => run ?? "").join("\n");
/** The program each command of a job's scripts starts, such as npm or node. */
const programs = (job: Job) =>
  runs(job)
    .replace(/\\\n/g, " ")
    .split(/\n|&&|\|\||;|\|/)
    .map((command) => command.trim().split(/\s+/)[0] ?? "")
    .filter((program) => program !== "" && !program.startsWith("#") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(program));

describe("the workflow that publishes @tiehall/packet", () => {
  it("runs only when a maintainer starts it, with no token permissions unless a job declares them", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs).sort()).toEqual(["build", "prepare", "publish"]);
  });

  it("stays off until the schema is published: the build and publish jobs run only when the release-URL tree holds a release", () => {
    expect(prepare.permissions).toEqual({ contents: "read" });
    expect(runs(prepare)).toContain('node tools/repo-checks/src/read-packet-publication.ts >> "$GITHUB_OUTPUT"');
    expect(prepare.outputs).toEqual({ published: "${{ steps.publication.outputs.published }}", version: "${{ steps.publication.outputs.version }}" });
    expect(build.needs).toBe("prepare");
    expect(publish.needs).toEqual(["prepare", "build"]);
    for (const job of [build, publish]) expect(job.if).toContain("needs.prepare.outputs.published == 'true'");
  });

  it("publishes only from main, whichever branch a maintainer starts it on", () => {
    // npm's trusted publishing trusts the workflow file, not the branch, so the jobs refuse every other ref themselves.
    for (const job of [build, publish]) expect(job.if).toBe("github.ref == 'refs/heads/main' && needs.prepare.outputs.published == 'true'");
  });

  it("builds the package, checks its content and validator and packs it in a job that can write nothing", () => {
    expect(build.permissions).toEqual({ contents: "read" });
    const script = runs(build);
    const install = script.indexOf("pnpm install --frozen-lockfile --filter @tiehall/packet");
    const built = script.indexOf('node packages/packet/src/build-package.ts --version "$VERSION" --out "$RUNNER_TEMP/package"');
    const check = script.indexOf('node packages/packet/src/check-package.ts "$RUNNER_TEMP/package"');
    const pack = script.indexOf('npm pack "$RUNNER_TEMP/package" --ignore-scripts --pack-destination "$RUNNER_TEMP/tarball"');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(built).toBeGreaterThan(install);
    expect(check).toBeGreaterThan(built);
    expect(pack).toBeGreaterThan(check);
    expect((build.steps ?? []).find(({ run }) => run?.includes("build-package.ts"))?.env).toEqual({ VERSION: "${{ needs.prepare.outputs.version }}" });
    // The tarball's name and digest go to the publish job, which checks the tarball it downloads against them.
    expect(build.outputs).toEqual({ tarball: "${{ steps.pack.outputs.tarball }}", sha256: "${{ steps.pack.outputs.sha256 }}" });
    const packStep = (build.steps ?? []).find(({ id }) => id === "pack");
    expect(packStep?.run).toContain('sha256sum "$tarball"');
    const upload = (build.steps ?? []).find(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "package", path: "${{ runner.temp }}/tarball/", "if-no-files-found": "error" });
  });

  it("publishes the checked tarball with provenance in a job that holds only the OIDC token and runs no package's code", () => {
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    for (const { uses } of publish.steps ?? []) if (uses !== undefined) expect(uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect((publish.steps ?? []).find(({ uses }) => uses?.startsWith("actions/setup-node@"))?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    // Nothing is installed and no repository script runs while the job holds the token: only the shell's tools and npm itself.
    expect(new Set(programs(publish))).toEqual(new Set(["echo", "sha256sum", "npm"]));
    expect(runs(publish)).not.toMatch(/\bpnpm\b|npm (?:install|ci|exec|run|pack)\b|\bnpx\b|\bnode\b/);
    const download = (publish.steps ?? []).findIndex(({ uses }) => uses?.startsWith("actions/download-artifact@"));
    expect((publish.steps ?? [])[download]?.with).toEqual({ name: "package", path: "${{ runner.temp }}/tarball" });
    const steps = (publish.steps ?? []).map(({ run }) => run ?? "");
    const verify = steps.findIndex((run) => run.includes("sha256sum --check --strict"));
    const upload = steps.findIndex((run) => run.includes("npm publish"));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(download);
    expect(upload).toBeGreaterThan(verify);
    expect((publish.steps ?? [])[verify]?.env).toEqual({ TARBALL: "${{ needs.build.outputs.tarball }}", SHA256: "${{ needs.build.outputs.sha256 }}" });
    expect(steps[upload]?.trim()).toBe('npm publish "./$TARBALL" --provenance --access public --ignore-scripts');
    expect((publish.steps ?? [])[upload]?.["working-directory"]).toBe("${{ runner.temp }}/tarball");
    // No token of ours: npm's trusted publishing takes the job's OIDC token.
    expect(JSON.stringify(workflow)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/);
  });
});

describe("reading the packet's publication", () => {
  it("says the schema is unpublished while the release-URL tree is empty, as it is now", () => {
    expect(packetPublication(root)).toEqual({ published: false });
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("published=false\nversion=\n");
    expect(run.stderr).toContain("No release of the packet schema is published yet, so @tiehall/packet is not published.");
  });

  it("gives the package the latest release's version once the tree holds releases", () => {
    const repo = join(scratch, "published");
    mkdirSync(join(repo, RELEASES_FOLDER), { recursive: true });
    for (const name of ["v1.0.json", "v1.1.json", "v1.json"]) writeFileSync(join(repo, RELEASES_FOLDER, name), "{}\n");
    expect(packetPublication(repo)).toEqual({ published: true, version: "1.1.0" });
    const run = spawnSync(process.execPath, [script, repo], { cwd: root, encoding: "utf8" });
    expect(run.stdout).toBe("published=true\nversion=1.1.0\n");
  });
});
