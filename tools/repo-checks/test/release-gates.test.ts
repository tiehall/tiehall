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

  it("are refused when the shell GitHub runs the script with, or the lines before the gate's command, let its failure through", () => {
    // GitHub runs a script with no shell named as bash -e, without pipefail, and only shell: bash with pipefail; a
    // job's defaults.run.shell, and else its workflow's, names the shell of a step that names none. Every gate step of
    // the real workflows is one line, so a line before the command that holds a reserved word, such as case or a
    // block's keyword given as an argument, a parenthesis or brace, a backtick, a here-document or a quote left open
    // (an escaped or ANSI-C quoted one included), a set other than one that turns on -e, -u, -x, -v or pipefail (set
    // -n, -o noexec and -t among them), or a trap, alias, function, exit, return, exec, eval, source, ., shopt, hash or
    // enable lets the failure through, or keeps the gate from running; so does a list carried on from the line before,
    // and a list after the command, even past a comment sign inside a quoted text. Run as GitHub runs them, in bash
    // 5.2 with a pnpm that exits 1 (and a sourced tools/test-env.sh that defines pnpm as a function), every site refused
    // here can exit 0, and the three that pass exit 1.
    const sites = Object.fromEntries(RELEASE_GATES.flatMap((each) => gateSites(fixture("script-swallowed"), each).map((site) => [`${site.file}#${site.job}`, site.goesOn])));
    expect(sites).toEqual({
      "checks.yml#fresh-install": false,
      "checks.yml#upgrade": true,
      "checks.yml#backup": true,
      "checks.yml#backup-if": true,
      "checks.yml#polling": true,
      "checks.yml#polling-or": true,
      "checks.yml#egress": true,
      "checks.yml#egress-function": true,
      "checks.yml#egress-exit": true,
      "checks.yml#egress-quoted": true,
      "checks.yml#egress-heredoc": true,
      "checks.yml#fresh-install-prelude": false,
      "checks.yml#egress-case": true,
      "checks.yml#egress-backtick": true,
      "checks.yml#egress-noexec": true,
      "checks.yml#polling-noexec": true,
      "checks.yml#backup-onecmd": true,
      "checks.yml#upgrade-keyword-argument": true,
      "checks.yml#egress-ansi-c": true,
      "checks.yml#egress-escaped-quote": true,
      "checks.yml#egress-source": true,
      "checks.yml#egress-eval": true,
      "checks.yml#egress-shopt": true,
      "checks.yml#egress-hash": true,
      "checks.yml#egress-quoted-hash": true,
      "release.yml#prepare": true,
      "release.yml#stability": false,
    });
    const problems = releaseGateProblems(fixture("script-swallowed"));
    expect(problems).toHaveLength(24);
    expect(problems).toContain("When the release check of stability levels fails in release.yml#prepare, step 2, the release still runs release.yml#release, which can push or publish.");
    expect(problems).toContain("When the upgrade test fails in checks.yml#upgrade, step 2, the release still runs release.yml#release, which can push or publish.");
    expect(problems).toContain("When the backup-and-restore test fails in checks.yml#backup, step 2, the release still runs release.yml#release, which can push or publish.");
    expect(problems).toContain("When the egress test fails in checks.yml#egress-case, step 2, the release still runs release.yml#release, which can push or publish.");
    expect(problems.join("\n")).not.toMatch(/checks\.yml#fresh-install|release\.yml#stability/);
    expect(check(fixture("script-swallowed")).status).toBe(1);
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
