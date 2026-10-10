import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateSites, publishingAfterFailure, publishingAfterSkip, publishingJobs, RELEASE_GATES, releaseGateProblems } from "../src/release-gates.ts";

// The release's gates (self-host-install: Upgrades apply migrations before the
// app starts; public-api: Each operation carries a stability level): the
// fresh-install, upgrade, backup-and-restore, polling-mode and egress tests
// and the release check of stability levels each stop the release when they
// fail. Each test below makes a gate fail, or a condition skip it, in the real
// release workflow and in fixture workflows, and works out which jobs that
// push or publish would still run, as GitHub runs a workflow.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/release-gates/${name}/`, import.meta.url));
const script = fileURLToPath(new URL("../src/check-release-gates.ts", import.meta.url));
const check = (folder: string) => spawnSync(process.execPath, [script, folder], { encoding: "utf8" });
const gate = (name: string) => RELEASE_GATES.find((each) => each.name === name)!;

describe("the release's gates", () => {
  it("are the fresh-install, upgrade, backup-and-restore, polling-mode and egress tests and the release check of stability levels", () => {
    expect(RELEASE_GATES.map(({ name }) => name)).toEqual([
      "the fresh-install test",
      "the upgrade test",
      "the backup-and-restore test",
      "the polling-mode test",
      "the egress test",
      "the release check of stability levels",
    ]);
  });

  it("each stop the real release when they fail: the jobs that push and publish then never run", () => {
    expect(publishingJobs(root)).toEqual(["push", "release"]);
    for (const each of RELEASE_GATES) {
      const sites = gateSites(root, each);
      expect(sites.length, each.name).toBeGreaterThan(0);
      for (const site of sites) expect(publishingAfterFailure(root, site), `${each.name} failing in ${site.file}#${site.job}`).toEqual([]);
    }
    expect(releaseGateProblems(root)).toEqual([]);
  });

  it("run on the release's own image, through the image checks, and the release check before the image is built", () => {
    const sites = Object.fromEntries(RELEASE_GATES.map((each) => [each.name, gateSites(root, each).map(({ file, job }) => `${file}#${job}`)]));
    expect(sites).toEqual({
      "the fresh-install test": ["image-checks.yml#fresh-install-test"],
      "the upgrade test": ["image-checks.yml#upgrade-test"],
      "the backup-and-restore test": ["image-checks.yml#backup-test"],
      "the polling-mode test": ["image-checks.yml#polling-test"],
      "the egress test": ["image-checks.yml#egress-test"],
      "the release check of stability levels": ["release.yml#prepare"],
    });
  });

  it("stop a fixture release when any of them fails, and the check passes it", () => {
    for (const each of RELEASE_GATES) {
      for (const site of gateSites(fixture("gated"), each)) expect(publishingAfterFailure(fixture("gated"), site), each.name).toEqual([]);
    }
    const run = check(fixture("gated"));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("the egress test runs in checks.yml#egress; when it fails, no job that pushes or publishes runs.");
  });

  it("are refused by the check when the job that publishes runs whatever they did", () => {
    const run = check(fixture("release-always"));
    expect(run.status).toBe(1);
    expect(releaseGateProblems(fixture("release-always"))).toHaveLength(6);
    expect(run.stderr).toContain("When the polling-mode test fails in checks.yml#polling, step 2, the release still runs release.yml#release, which can push or publish.");
    expect(run.stderr).toContain("When the release check of stability levels fails in release.yml#prepare, step 2, the release still runs release.yml#release");
  });

  it("are refused when the job that publishes does not wait for the image checks, or waits through a job that runs whatever they did", () => {
    const failing = (name: string) => releaseGateProblems(fixture(name)).map((problem) => / fails in ([^,]+),/.exec(problem)?.[1]);
    const tests = ["checks.yml#fresh-install", "checks.yml#upgrade", "checks.yml#backup", "checks.yml#polling", "checks.yml#egress"];
    // The release check still stops it: the job that publishes needs the job that runs the check.
    expect(failing("release-not-needing-checks")).toEqual(tests);
    expect(publishingAfterFailure(fixture("release-not-needing-checks"), gateSites(fixture("release-not-needing-checks"), gate("the release check of stability levels"))[0]!)).toEqual([]);
    // A job between them that runs unless the run was cancelled lets every failure through.
    expect(failing("always-in-between")).toEqual([...tests, "release.yml#prepare"]);
  });

  it("are refused when a failing test may continue on error, for its job or its step, or when a condition may skip it", () => {
    expect(releaseGateProblems(fixture("continue-on-error"))).toEqual([
      "When the polling-mode test fails in checks.yml#polling, step 2, the release still runs release.yml#release, which can push or publish.",
      "When the egress test fails in checks.yml#egress, step 2, the release still runs release.yml#release, which can push or publish.",
    ]);
    expect(releaseGateProblems(fixture("conditional-step"))).toEqual([
      "When the fresh-install test fails in checks.yml#fresh-install, step 2, the release still runs release.yml#release, which can push or publish.",
    ]);
  });

  it("are refused when the script that runs one goes on, or ends in success, after it fails", () => {
    const sites = Object.fromEntries(RELEASE_GATES.flatMap((each) => gateSites(fixture("script-goes-on"), each).map((site) => [each.name, site.goesOn])));
    expect(sites).toEqual({
      "the fresh-install test": true,
      "the upgrade test": false,
      "the backup-and-restore test": true,
      "the polling-mode test": true,
      "the egress test": true,
      "the release check of stability levels": false,
    });
    expect(releaseGateProblems(fixture("script-goes-on"))).toEqual([
      "When the fresh-install test fails in checks.yml#fresh-install, step 2, the release still runs release.yml#release, which can push or publish.",
      "When the backup-and-restore test fails in checks.yml#backup, step 2, the release still runs release.yml#release, which can push or publish.",
      "When the polling-mode test fails in checks.yml#polling, step 2, the release still runs release.yml#release, which can push or publish.",
      "When the egress test fails in checks.yml#egress, step 2, the release still runs release.yml#release, which can push or publish.",
    ]);
    expect(check(fixture("script-goes-on")).status).toBe(1);
  });

  it("are refused when a condition on the job that runs one, or on a job it needs, may skip it in a workflow the release calls", () => {
    // A skipped job fails neither the workflow that calls it nor the jobs that need it, so the release goes on untested.
    expect(publishingAfterSkip(fixture("skipped-gate-job"), gateSites(fixture("skipped-gate-job"), gate("the egress test"))[0]!)).toEqual(["release"]);
    expect(releaseGateProblems(fixture("skipped-gate-job"))).toEqual([
      "When a job's condition skips the polling-mode test in checks.yml#polling, the release still runs release.yml#release, which can push or publish.",
      "When a job's condition skips the egress test in checks.yml#egress, the release still runs release.yml#release, which can push or publish.",
    ]);
    const run = check(fixture("skipped-gate-job"));
    expect(run.status).toBe(1);
    // Skipping the release workflow's own gate job skips every job that needs it, the jobs that publish among them.
    expect(publishingAfterSkip(fixture("skipped-gate-job"), gateSites(fixture("skipped-gate-job"), gate("the release check of stability levels"))[0]!)).toEqual([]);
    expect(run.stdout).toContain("the release check of stability levels runs in release.yml#prepare; when it fails, no job that pushes or publishes runs.");
    // The real release has no such condition.
    for (const each of RELEASE_GATES) for (const site of gateSites(root, each)) expect(publishingAfterSkip(root, site), each.name).toEqual([]);
  });

  it("are refused when one does not run in the release at all, or runs only in the job that publishes", () => {
    expect(releaseGateProblems(fixture("missing-gates"))).toEqual([
      "the polling-mode test runs in no step of release.yml or of a workflow it calls.",
      "the release check of stability levels runs in no step of release.yml or of a workflow it calls.",
    ]);
    expect(releaseGateProblems(fixture("publish-before-gates"))).toEqual([
      "When the release check of stability levels fails in release.yml#release, step 2, the release still runs release.yml#release, which can push or publish.",
    ]);
  });

  it("passes on the real tree, as CI runs it", () => {
    const run = check(root);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("the fresh-install test runs in image-checks.yml#fresh-install-test; when it fails, no job that pushes or publishes runs.");
  });
});
