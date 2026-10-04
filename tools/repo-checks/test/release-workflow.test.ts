import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { RELEASE_FILES } from "../src/release-files.ts";

// The release workflow (self-host-install: Releases carry signed
// attestations; self-host-install: Release pipeline integrity; design.md,
// Technical decisions: T13). A version tag builds the image once, for the
// release's version; the image is pushed once, by digest and tagged with the
// version, and that digest gets signed build-provenance and SBOM attestations,
// pushed beside it; the release page names the digest and the version tag and
// offers compose.yaml, the Caddyfile, .env.example, backup.sh, restore.sh and
// the release notes. Only the job that publishes holds write permissions, and
// the SBOM comes from the third-party scanner in a job with no permissions.

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps?: Step[];
  uses?: string;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")) as Workflow;
const build = parse(readFileSync(join(root, ".github/workflows/build.yml"), "utf8")) as Workflow;
const jobs = Object.entries(workflow.jobs);
const steps = (job: Job | undefined): Step[] => job?.steps ?? [];
const runs = (job: Job | undefined): string => steps(job).map(({ run }) => run ?? "").join("\n");
const writes = (job: Job): string[] => Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write").map(([scope]) => scope).sort();
/** The job, by its id, that runs a command matching the pattern; it fails unless exactly one does. */
function jobRunning(pattern: RegExp): [string, Job] {
  const found = jobs.filter(([, job]) => pattern.test(runs(job)));
  expect(found.map(([id]) => id), String(pattern)).toHaveLength(1);
  return found[0] as [string, Job];
}
const needs = (job: Job): string[] => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

describe("the release workflow", () => {
  it("runs on a version tag and on nothing else, with no token permissions unless a job declares them", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
    expect(workflow.permissions).toEqual({});
    for (const [id, job] of jobs) if (job.uses === undefined) expect(job["timeout-minutes"], id).toBeGreaterThan(0);
  });

  it("reads the release from its tag first, refusing a tag that names no version or no commit of main", () => {
    const [id, job] = jobRunning(/node tools\/repo-checks\/src\/read-release-tag\.ts "\$TAG"/);
    expect(id).toBe("prepare");
    expect(steps(job).find(({ run }) => run?.includes("read-release-tag.ts"))?.env).toEqual({ TAG: "${{ github.ref_name }}" });
    // The tags and main's history, to check the commit and find the previous release.
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/checkout@"))?.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
    expect(writes(job)).toEqual([]);
  });

  it("checks, before anything is built, that the release notes can be written from the changelog, the migrations and the no-skip list", () => {
    const job = workflow.jobs["prepare"] as Job;
    const order = steps(job).map(({ id, run }) => id ?? (run?.includes("write-release-notes.ts") ? "notes" : undefined));
    expect(order.indexOf("tag")).toBeLessThan(order.indexOf("notes"));
    const check = steps(job).find(({ run }) => run?.includes("write-release-notes.ts"));
    expect(check?.run?.trim()).toBe('node tools/repo-checks/src/write-release-notes.ts "$VERSION" --previous "$PREVIOUS" --check');
    expect(check?.env).toEqual({ VERSION: "${{ steps.tag.outputs.version }}", PREVIOUS: "${{ steps.tag.outputs.previous }}" });
  });

  it("builds the image once, as the Build workflow does, but for the release's version, in a job that can write nothing", () => {
    const builds = jobs.filter(([, job]) => /\bdocker build\b/.test(runs(job)));
    expect(builds.map(([id]) => id)).toEqual(["build"]);
    const [, job] = builds[0] as [string, Job];
    expect(needs(job)).toEqual(["prepare"]);
    expect(writes(job)).toEqual([]);
    const script = runs(job).replace(/\\\n\s*/g, "");
    expect(script.match(/\bdocker build\b/g)).toHaveLength(1);
    expect(script).toContain('--build-arg TIEHALL_VERSION="$VERSION"');
    const run = steps(job).find(({ run }) => run?.includes("docker build"));
    expect(run?.env?.["VERSION"]).toBe("${{ needs.prepare.outputs.version }}");
    // The same build as each build of main, so the release's image differs from main's only in its version.
    const main = (build.jobs["build"]?.steps ?? []).map(({ run }) => run ?? "").join("\n");
    for (const option of ["--platform linux/amd64", "--provenance=false", "--sbom=false", '--build-arg TIEHALL_COMMIT_SHA="$GITHUB_SHA"', '--build-arg TIEHALL_IMAGE_NAME="$repository"', '--build-arg TIEHALL_SOURCE_REPOSITORY="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"', '--label org.opencontainers.image.source="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"']) {
      expect(main, option).toContain(option);
      expect(script, option).toContain(option);
    }
    expect(script).toContain('--tag "$repository:$VERSION"');
    expect(script).toContain('docker save "$repository:$VERSION" --output "$RUNNER_TEMP/image.tar"');
    const upload = steps(job).find(({ uses }) => uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "image", path: "${{ runner.temp }}/image.tar", "if-no-files-found": "error" });
  });

  it("writes the SBOM with the pinned scanner, offline, in a job with no permissions and no secrets", () => {
    const [id, job] = jobRunning(/--format spdx-json/);
    expect(id).toBe("sbom");
    expect(job.permissions).toEqual({});
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
    expect(job.env?.["TRIVY_IMAGE"]).toBe(build.jobs["scan"]?.env?.["TRIVY_IMAGE"]);
    expect(job.env?.["TRIVY_IMAGE"]).toMatch(/@sha256:[0-9a-f]{64}$/);
    const script = runs(job).replace(/\\\n\s*/g, "");
    for (const option of ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--input /image.tar", "--output /sbom/sbom.spdx.json"]) expect(script, option).toContain(option);
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/download-artifact@"))?.with).toMatchObject({ name: "image" });
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/upload-artifact@"))?.with).toMatchObject({ name: "sbom", "if-no-files-found": "error" });
  });

  it("pushes the image once, in the job that publishes, by digest and tagged with its version", () => {
    const pushes = jobs.filter(([, job]) => /\bdocker push\b/.test(runs(job)));
    expect(pushes.map(([id]) => id)).toEqual(["release"]);
    const [, job] = pushes[0] as [string, Job];
    const push = steps(job).find(({ id }) => id === "push");
    expect(push?.run).toContain('docker load --input "$RUNNER_TEMP/image/image.tar"');
    expect(push?.run).toContain('docker push "$repository:$VERSION"');
    expect(push?.run).toContain(`digest="$(docker buildx imagetools inspect "$repository:$VERSION" --format '{{.Manifest.Digest}}')"`);
    expect((push?.run?.match(/\bdocker push\b/g) ?? []).length).toBe(1);
  });

  it("attests the pushed digest's build provenance and its SBOM, signed and pushed beside the image", () => {
    const job = workflow.jobs["release"];
    const attests = steps(job).filter(({ uses }) => uses?.startsWith("actions/attest@"));
    expect(attests).toHaveLength(2);
    for (const attest of attests) {
      expect(attest.with).toMatchObject({
        "subject-name": "${{ steps.push.outputs.repository }}",
        "subject-digest": "${{ steps.push.outputs.digest }}",
        "push-to-registry": true,
      });
      expect(attest.if).toBeUndefined();
    }
    // Without a predicate the action attests build provenance; with sbom-path, the SBOM.
    expect(attests.map((attest) => attest.with?.["sbom-path"])).toEqual([undefined, "${{ runner.temp }}/sbom/sbom.spdx.json"]);
    expect(attests.map((attest) => attest.with?.["predicate-type"] ?? attest.with?.["predicate-path"])).toEqual([undefined, undefined]);
    const order = steps(job).map(({ id, uses, run }) => id ?? uses?.split("@")[0] ?? run?.split("\n")[0]);
    expect(order.indexOf("push")).toBeLessThan(order.indexOf("actions/attest"));
  });

  it("publishes the release for its tag with the notes and every release file, after the attestations", () => {
    const job = workflow.jobs["release"] as Job;
    expect(needs(job)).toEqual(expect.arrayContaining(["prepare", "build", "sbom"]));
    const script = runs(job).replace(/\\\n\s*/g, "");
    expect(script).toContain('node tools/repo-checks/src/stage-release-files.ts "$RUNNER_TEMP/release"');
    expect(script).toContain('node tools/repo-checks/src/write-release-notes.ts "$VERSION"');
    expect(script).toContain('--image "$IMAGE"');
    // The previous release's migrations, read from its tag, tell which contract steps this release adds.
    expect(script).toContain('--previous "$PREVIOUS"');
    expect(steps(job).find(({ run }) => run?.includes("write-release-notes.ts"))?.env?.["PREVIOUS"]).toBe("${{ needs.prepare.outputs.previous }}");
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/checkout@"))?.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
    expect(script).toContain('--output "$RUNNER_TEMP/release/release-notes.md"');
    expect(script).toMatch(/gh release create "\$TAG" --repo "\$GITHUB_REPOSITORY" --verify-tag --title "Tiehall \$VERSION" --notes-file "\$RUNNER_TEMP\/release\/release-notes\.md" "\$\{prerelease\[@\]\}" "\$RUNNER_TEMP"\/release\/\*/);
    const publish = steps(job).find(({ run }) => run?.includes("gh release create"));
    expect(publish?.env).toMatchObject({ GH_TOKEN: "${{ github.token }}", TAG: "${{ github.ref_name }}", PRERELEASE: "${{ needs.prepare.outputs.prerelease }}" });
    const notes = steps(job).find(({ run }) => run?.includes("write-release-notes.ts"));
    expect(notes?.env?.["IMAGE"]).toBe("${{ steps.push.outputs.repository }}:${{ needs.prepare.outputs.version }}@${{ steps.push.outputs.digest }}");
    const order = steps(job).map(({ run, uses }) => (run?.includes("gh release create") ? "publish" : uses?.startsWith("actions/attest@") ? "attest" : "other"));
    expect(order.lastIndexOf("attest")).toBeLessThan(order.indexOf("publish"));
    // Every release file is staged by the script, from the list the notes and the docs' download use.
    expect(RELEASE_FILES).toHaveLength(5);
  });

  it("holds write permissions only in the job that publishes, which uses only GitHub's own actions", () => {
    expect(jobs.filter(([, job]) => writes(job).length > 0).map(([id]) => id)).toEqual(["release"]);
    expect(writes(workflow.jobs["release"] as Job)).toEqual(["attestations", "contents", "id-token", "packages"]);
    for (const { uses } of steps(workflow.jobs["release"])) if (uses !== undefined) expect(uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    // The job's token goes to GHCR only for the push and the attestations, and the job logs out after them.
    const logout = steps(workflow.jobs["release"]).find(({ run }) => run?.trim() === "docker logout ghcr.io");
    expect(logout?.if).toBe("always()");
  });
});
