import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { RELEASE_FILES, RELEASE_NOTES_ASSET } from "../src/release-files.ts";
import { checkWorkflows } from "../src/workflows.ts";

// The release workflow (self-host-install: Releases carry signed
// attestations; self-host-install: Release pipeline integrity; design.md,
// Technical decisions: T13). A version tag builds the image once, for the
// release's version; the image is pushed once, by digest and tagged with the
// version, and that digest gets signed build-provenance and SBOM attestations,
// pushed beside it; the release page names the digest and the version tag and
// offers compose.yaml, the Caddyfile, .env.example, backup.sh, restore.sh and
// the release notes. Only the job that pushes and attests the image and the
// job that publishes the release hold write permissions, and neither runs a
// third-party action or any package's code: the notes, whose script needs the
// repository's dependencies, are written between them in a job that can write
// nothing. The SBOM comes from the third-party scanner in a job with no
// permissions, and so does the vulnerability scan, the Build workflow's scan
// on the release's own image, whose finding of a fixable HIGH or CRITICAL
// vulnerability stops the release before anything is pushed (design.md,
// Technical decisions: T13, R-d).

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
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

  it("runs the release check of stability levels before anything is built, and the image checks on the release's own image", () => {
    const prepare = steps(workflow.jobs["prepare"]).map(({ run }) => run?.trim());
    expect(prepare).toContain("pnpm release:check-stability");
    const image = workflow.jobs["image"] as Job & { with?: Record<string, unknown> };
    expect(image.uses).toBe("./.github/workflows/image-checks.yml");
    expect(needs(image)).toEqual(["prepare", "build"]);
    expect(image.with).toEqual({ "image-artifact": "image", "previous-base": "${{ github.sha }}^" });
    expect(image.permissions).toEqual({ contents: "read", packages: "read" });
    expect(needs(workflow.jobs["push"] as Job)).toEqual(["prepare", "build", "sbom", "scan", "image"]);
    expect(needs(workflow.jobs["release"] as Job)).toEqual(expect.arrayContaining(["push"]));
    // The image checks load the saved image and take the previous image from the base the release gives.
    const checks = parse(readFileSync(join(root, ".github/workflows/image-checks.yml"), "utf8")) as Workflow & { on: { workflow_call: { inputs: Record<string, unknown> } } };
    expect(Object.keys(checks.on.workflow_call.inputs)).toEqual(["image", "image-artifact", "previous-base"]);
    for (const [id, job] of Object.entries(checks.jobs)) {
      const download = steps(job).findIndex(({ uses }) => uses?.startsWith("actions/download-artifact@"));
      const get = steps(job).findIndex(({ run }) => run?.startsWith("tools/image-tests/get-image.sh"));
      expect(download, id).toBeGreaterThanOrEqual(0);
      expect(download, id).toBeLessThan(get);
      expect(steps(job)[download]?.if, id).toBe("inputs.image-artifact != ''");
      expect(steps(job)[get]?.env?.["IMAGE_ARCHIVE"], id).toBe("${{ inputs.image-artifact != '' && format('{0}/image/image.tar', runner.temp) || '' }}");
      const previous = steps(job).find(({ run }) => run?.startsWith("tools/image-tests/get-previous-image.sh"));
      if (previous !== undefined) expect(previous.env?.["BASE"], id).toBe("${{ inputs.previous-base || github.event.pull_request.base.sha || github.event.before }}");
    }
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

  it("scans the release's own image as the Build workflow scans each build of main, in a job with no permissions, before anything is pushed", () => {
    const [id, job] = jobRunning(/--scanners vuln/);
    expect(id).toBe("scan");
    expect(needs(job)).toEqual(["build"]);
    expect(job.permissions).toEqual({});
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
    // The same scanner, pinned by the same digest, and the same command: fixable HIGH and CRITICAL vulnerabilities fail it.
    expect(job.env?.["TRIVY_IMAGE"]).toBe(build.jobs["scan"]?.env?.["TRIVY_IMAGE"]);
    const command = (each: Job | undefined) =>
      runs(each).replace(/\\\n\s*/g, " ").split("\n").find((line) => line.includes("--scanners vuln"))?.trim().replace(/\s+/g, " ");
    expect(command(job)).toBe(command(build.jobs["scan"]));
    expect(command(job)).toContain("--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1");
    // It scans the saved image only once its digest matches the build job's, which no other job can change.
    const scanSteps = steps(job);
    const download = scanSteps.findIndex(({ uses }) => uses?.startsWith("actions/download-artifact@"));
    expect(scanSteps[download]?.with).toEqual({ name: "image", path: "${{ runner.temp }}" });
    const check = scanSteps.findIndex(({ run }) => run?.trim() === 'echo "$ARCHIVE_SHA256  $RUNNER_TEMP/image.tar" | sha256sum --check --strict');
    expect(check).toBeGreaterThan(download);
    expect(check).toBeLessThan(scanSteps.findIndex(({ run }) => run?.includes("--scanners vuln")));
    expect(scanSteps[check]?.env).toEqual({ ARCHIVE_SHA256: "${{ needs.build.outputs.archive-sha256 }}" });
    // The job that pushes needs it, and the job that publishes needs that one.
    expect(needs(workflow.jobs["push"] as Job)).toContain("scan");
  });

  it("pushes the image once, in the push job, by digest and tagged with its version", () => {
    const pushes = jobs.filter(([, job]) => /\bdocker push\b/.test(runs(job)));
    expect(pushes.map(([id]) => id)).toEqual(["push"]);
    const [, job] = pushes[0] as [string, Job];
    const push = steps(job).find(({ id }) => id === "push");
    expect(push?.run).toContain('docker load --input "$RUNNER_TEMP/image/image.tar"');
    expect(push?.run).toContain('docker push "$repository:$VERSION"');
    expect(push?.run).toContain(`digest="$(docker buildx imagetools inspect "$repository:$VERSION" --format '{{.Manifest.Digest}}')"`);
    expect((push?.run?.match(/\bdocker push\b/g) ?? []).length).toBe(1);
    expect((job as Job & { outputs?: Record<string, string> }).outputs).toEqual({
      repository: "${{ steps.push.outputs.repository }}",
      digest: "${{ steps.push.outputs.digest }}",
    });
  });

  it("attests the pushed digest's build provenance and its SBOM, signed and pushed beside the image", () => {
    const job = workflow.jobs["push"];
    const attests = steps(job).filter(({ uses }) => uses?.startsWith("actions/attest@"));
    expect(attests).toHaveLength(2);
    expect(jobs.filter(([, each]) => steps(each).some(({ uses }) => uses?.startsWith("actions/attest@"))).map(([id]) => id)).toEqual(["push"]);
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

  it("the job that pushes checks that the image it loads is the one the build job built, and the SBOM the one the SBOM job wrote", () => {
    // The build job gives the saved image's digest and the image's ID, which no other job can change.
    const build = workflow.jobs["build"] as Job;
    expect(build.outputs).toEqual({ "image-id": "${{ steps.build.outputs.image-id }}", "archive-sha256": "${{ steps.build.outputs.archive-sha256 }}" });
    const built = steps(build).find(({ id }) => id === "build")?.run ?? "";
    const save = built.indexOf('docker save "$repository:$VERSION" --output "$RUNNER_TEMP/image.tar"');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(built.indexOf(`echo "image-id=$(docker image inspect "$repository:$VERSION" --format '{{.Id}}')" >> "$GITHUB_OUTPUT"`)).toBeGreaterThan(save);
    expect(built.indexOf(`echo "archive-sha256=$(sha256sum "$RUNNER_TEMP/image.tar" | cut -d ' ' -f 1)" >> "$GITHUB_OUTPUT"`)).toBeGreaterThan(save);

    // The SBOM job scans only that saved image, and gives the SBOM's digest once the scanner has written it.
    const sbom = workflow.jobs["sbom"] as Job;
    const sbomSteps = steps(sbom);
    const sbomCheck = sbomSteps.findIndex(({ run }) => run?.trim() === 'echo "$ARCHIVE_SHA256  $RUNNER_TEMP/image/image.tar" | sha256sum --check --strict');
    expect(sbomCheck).toBeGreaterThan(sbomSteps.findIndex(({ uses }) => uses?.startsWith("actions/download-artifact@")));
    expect(sbomCheck).toBeLessThan(sbomSteps.findIndex(({ run }) => run?.includes("--format spdx-json")));
    expect(sbomSteps[sbomCheck]?.env).toEqual({ ARCHIVE_SHA256: "${{ needs.build.outputs.archive-sha256 }}" });
    expect(sbom.outputs).toEqual({ sha256: "${{ steps.digest.outputs.sha256 }}" });
    const digest = sbomSteps.findIndex(({ id }) => id === "digest");
    expect(digest).toBeGreaterThan(sbomSteps.findIndex(({ run }) => run?.includes("--format spdx-json")));
    expect(sbomSteps[digest]?.run).toContain(`echo "sha256=$(sha256sum "$RUNNER_TEMP/sbom/sbom.spdx.json" | cut -d ' ' -f 1)" >> "$GITHUB_OUTPUT"`);

    // The push job checks both downloads before it loads the image, and the loaded image's ID before it pushes it.
    const push = workflow.jobs["push"] as Job;
    const pushSteps = steps(push);
    const check = pushSteps.findIndex(({ id }) => id === "check");
    expect(check).toBeGreaterThan(pushSteps.map(({ uses }) => uses?.startsWith("actions/download-artifact@") ?? false).lastIndexOf(true));
    expect(check).toBeLessThan(pushSteps.findIndex(({ id }) => id === "push"));
    expect(pushSteps[check]?.env).toEqual({ ARCHIVE_SHA256: "${{ needs.build.outputs.archive-sha256 }}", SBOM_SHA256: "${{ needs.sbom.outputs.sha256 }}" });
    expect(pushSteps[check]?.run).toContain('echo "$ARCHIVE_SHA256  $RUNNER_TEMP/image/image.tar" | sha256sum --check --strict');
    expect(pushSteps[check]?.run).toContain('echo "$SBOM_SHA256  $RUNNER_TEMP/sbom/sbom.spdx.json" | sha256sum --check --strict');
    const step = pushSteps.find(({ id }) => id === "push");
    expect(step?.env?.["IMAGE_ID"]).toBe("${{ needs.build.outputs.image-id }}");
    const script = step?.run ?? "";
    const load = script.indexOf('docker load --input "$RUNNER_TEMP/image/image.tar"');
    const inspect = script.indexOf(`loaded="$(docker image inspect "$repository:$VERSION" --format '{{.Id}}')"`);
    const compare = script.indexOf('if [ "$loaded" != "$IMAGE_ID" ]; then');
    const login = script.indexOf("docker login");
    expect(load).toBeGreaterThanOrEqual(0);
    expect(inspect).toBeGreaterThan(load);
    expect(compare).toBeGreaterThan(inspect);
    expect(login).toBeGreaterThan(compare);
    expect(script.slice(compare, login)).toContain("exit 1");
  });

  it("writes the release notes from the pushed digest in a job that can write nothing", () => {
    const [id, job] = jobRunning(/node tools\/repo-checks\/src\/write-release-notes\.ts "\$VERSION" \\/);
    expect(id).toBe("notes");
    expect(writes(job)).toEqual([]);
    expect(needs(job)).toEqual(["prepare", "push"]);
    const script = runs(job).replace(/\\\n\s*/g, "");
    expect(script).toContain('--image "$IMAGE"');
    // The commit the tag points to, which the notes pin the contract Action by (contract-changes: The contract Action).
    expect(script).toContain('--commit "$GITHUB_SHA"');
    // The previous release's migrations, read from its tag, tell which contract steps this release adds.
    expect(script).toContain('--previous "$PREVIOUS"');
    expect(script).toContain('--output "$RUNNER_TEMP/notes/release-notes.md"');
    const notes = steps(job).find(({ run }) => run?.includes("write-release-notes.ts"));
    expect(notes?.env).toEqual({
      VERSION: "${{ needs.prepare.outputs.version }}",
      PREVIOUS: "${{ needs.prepare.outputs.previous }}",
      IMAGE: "${{ needs.push.outputs.repository }}:${{ needs.prepare.outputs.version }}@${{ needs.push.outputs.digest }}",
    });
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/checkout@"))?.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
    expect(steps(job).find(({ uses }) => uses?.startsWith("actions/upload-artifact@"))?.with).toMatchObject({
      name: "notes",
      path: "${{ runner.temp }}/notes/release-notes.md",
      "if-no-files-found": "error",
    });
  });

  it("publishes the release for its tag with the notes and every release file, after the attestations", () => {
    const job = workflow.jobs["release"] as Job;
    expect(needs(job)).toEqual(["prepare", "push", "notes"]);
    const script = runs(job).replace(/\\\n\s*/g, "");
    // The release files come from the tag's own commit, staged by the script from the list the notes and the docs' download use.
    expect(script).toContain('node tools/repo-checks/src/stage-release-files.ts "$RUNNER_TEMP/release" --notes "$RUNNER_TEMP/notes"');
    expect(RELEASE_FILES).toHaveLength(5);
    const publish = steps(job).find(({ run }) => run?.includes("gh release create"));
    expect(publish?.["working-directory"]).toBe("${{ runner.temp }}/release");
    const command = (publish?.run ?? "").replace(/\\\n\s*/g, "").split("\n").find((line) => line.includes("gh release create"))?.trim();
    expect(command).toBe(
      'gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Tiehall $VERSION" --notes-file release-notes.md "${prerelease[@]}" ' +
        [...RELEASE_FILES.map(({ asset }) => asset), RELEASE_NOTES_ASSET].join(" "),
    );
    expect(publish?.env).toMatchObject({ GH_TOKEN: "${{ github.token }}", TAG: "${{ github.ref_name }}", PRERELEASE: "${{ needs.prepare.outputs.prerelease }}" });
    const order = steps(job).map(({ run, uses }) => (run?.includes("gh release create") ? "publish" : run?.includes("stage-release-files.ts") ? "stage" : uses?.startsWith("actions/download-artifact@") ? "notes" : "other"));
    expect(order.indexOf("notes")).toBeLessThan(order.indexOf("stage"));
    expect(order.indexOf("stage")).toBeLessThan(order.indexOf("publish"));
  });

  it("takes from the notes job only the notes, in a folder of their own, and publishes only the files it names", () => {
    // The notes job runs the repository's dependencies, whose code could put a forged compose.yaml in the notes
    // artifact, or a folder of files in the notes' place; the staging script stages the notes only when their folder
    // holds release-notes.md alone, as a regular file, and the release names each file it publishes.
    const job = workflow.jobs["release"] as Job;
    const downloads = steps(job).filter(({ uses }) => uses?.startsWith("actions/download-artifact@"));
    expect(downloads.map(({ with: inputs }) => inputs)).toEqual([{ name: "notes", path: "${{ runner.temp }}/notes" }]);
    const publish = steps(job).find(({ run }) => run?.includes("gh release create"));
    expect(publish?.run).not.toMatch(/[*?]|\$RUNNER_TEMP\/notes/);
  });

  it("holds write permissions only in the push job and the release job, which use only GitHub's own actions", () => {
    expect(jobs.filter(([, job]) => writes(job).length > 0).map(([id]) => id)).toEqual(["push", "release"]);
    expect(writes(workflow.jobs["push"] as Job)).toEqual(["attestations", "id-token", "packages"]);
    expect(writes(workflow.jobs["release"] as Job)).toEqual(["contents"]);
    for (const id of ["push", "release"]) for (const { uses } of steps(workflow.jobs[id])) if (uses !== undefined) expect(uses, id).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    // The job's token goes to GHCR only for the push and the attestations, and the job logs out after them.
    const logout = steps(workflow.jobs["push"]).find(({ run }) => run?.trim() === "docker logout ghcr.io");
    expect(logout?.if).toBe("always()");
  });

  it("the job that pushes the image runs no third-party code", () => {
    const push = workflow.jobs["push"] as Job;
    // No checkout, no Node and no package manager: only GitHub's own actions, Docker and the shell.
    expect(steps(push).filter(({ uses }) => uses !== undefined).map(({ uses }) => uses?.split("@")[0])).toEqual([
      "actions/download-artifact",
      "actions/download-artifact",
      "actions/attest",
      "actions/attest",
    ]);
    expect(runs(push)).not.toMatch(/\b(?:npm|npx|pnpm|yarn|node)\b|docker (?:run|create|compose)\b/);
    // The release job runs the repository's script that stages the release files, which imports only Node's own
    // modules, and installs nothing.
    const release = workflow.jobs["release"] as Job;
    expect(runs(release)).not.toMatch(/\b(?:npm|npx|pnpm|yarn)\b|docker (?:run|create|compose)\b/);
    const staging = readFileSync(join(root, "tools/repo-checks/src/stage-release-files.ts"), "utf8") + readFileSync(join(root, "tools/repo-checks/src/release-files.ts"), "utf8");
    for (const [, specifier] of staging.matchAll(/^import [^"]*"([^"]+)";$/gm)) expect(specifier).toMatch(/^node:|^\.\/release-files\.ts$/);
    // And the workflow check finds nothing in the release workflow, whose write jobs it holds to the same rule.
    expect(checkWorkflows(root).filter(({ file }) => file === "release.yml")).toEqual([]);
  });
});
