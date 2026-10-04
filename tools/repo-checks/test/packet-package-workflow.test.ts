import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { packetPublication } from "../src/packet-publication.ts";
import { RELEASES_FOLDER } from "../src/packet-releases.ts";

// The CI job that publishes @tiehall/packet (handoff-packet: The npm package;
// public-api: Client pieces are built from public source with provenance;
// design.md, Technical decisions: T13). It builds the package from this
// repository, checks its content and its validator, and publishes it to npm
// with provenance through npm's trusted publishing, holding only the OIDC
// token permission and running only GitHub's own actions. It stays off until
// the schema is published: a maintainer starts the workflow, and its publish
// job runs only when the release-URL tree holds a release, whose version the
// package takes (handoff-packet: When the schema is published).

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
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}

const workflow = parse(readFileSync(join(root, ".github/workflows/packet-package.yml"), "utf8")) as { on: unknown; permissions: unknown; jobs: Record<string, Job> };
const prepare = workflow.jobs["prepare"] as Job;
const publish = workflow.jobs["publish"] as Job;
const runs = (job: Job) => (job.steps ?? []).map(({ run }) => run ?? "").join("\n");

describe("the workflow that publishes @tiehall/packet", () => {
  it("runs only when a maintainer starts it, with no token permissions unless a job declares them", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs).sort()).toEqual(["prepare", "publish"]);
  });

  it("stays off until the schema is published: the publish job runs only when the release-URL tree holds a release", () => {
    expect(prepare.permissions).toEqual({ contents: "read" });
    expect(runs(prepare)).toContain('node tools/repo-checks/src/read-packet-publication.ts >> "$GITHUB_OUTPUT"');
    expect(prepare.outputs).toEqual({ published: "${{ steps.publication.outputs.published }}", version: "${{ steps.publication.outputs.version }}" });
    expect(publish.needs).toBe("prepare");
    expect(publish.if).toBe("needs.prepare.outputs.published == 'true'");
  });

  it("builds the package, checks its content and validator, then publishes it with provenance, holding only the OIDC token", () => {
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    for (const { uses } of publish.steps ?? []) if (uses !== undefined) expect(uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect((publish.steps ?? []).find(({ uses }) => uses?.startsWith("actions/setup-node@"))?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    const script = runs(publish);
    const build = script.indexOf('node packages/packet/src/build-package.ts --version "$VERSION" --out "$RUNNER_TEMP/package"');
    const check = script.indexOf('node packages/packet/src/check-package.ts "$RUNNER_TEMP/package"');
    const upload = script.indexOf("npm publish --provenance --access public --ignore-scripts");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(check);
    expect((publish.steps ?? []).find(({ run }) => run?.includes("npm publish"))?.["working-directory"]).toBe("${{ runner.temp }}/package");
    expect((publish.steps ?? []).find(({ run }) => run?.includes("build-package.ts"))?.env).toEqual({ VERSION: "${{ needs.prepare.outputs.version }}" });
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
