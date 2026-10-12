import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseReleaseImage, renderReleaseNotes } from "../src/release-notes.ts";
import {
  RELEASE_AGE_EXCEPTIONS,
  RELEASE_AGE_LABEL,
  releaseAgeExceptions,
  releaseAgeLabelProblems,
  releaseAgeViolations,
  type ReleaseAgeException,
} from "../src/release-age.ts";
import { checkWorkflows } from "../src/workflows.ts";

// A reviewed exception to the release age (self-host-install: Release
// pipeline integrity; decisions-from-groups-15-28: design.md, Decisions this
// change rests on: D55 (86); Technical decisions: T16). pnpm resolves only
// versions published at least 7 days ago, unless pnpm-workspace.yaml's
// minimumReleaseAgeExclude lets one in sooner. Such an exclusion passes the
// workflow check only when it names one package at one exact version that
// tools/repo-checks/release-age-exceptions.json records, with the advisory
// that names the version as fixed, the label release-age-exception and the day
// the version turns 7 days old, and only until that day has passed. The
// API-compatibility workflow's label step fails a pull request that adds an
// exclusion without the label, and the release notes list the exceptions a
// release carries.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const checkWorkflowsScript = fileURLToPath(new URL("../src/check-workflows.ts", import.meta.url));
const labelScript = fileURLToPath(new URL("../src/check-release-age-label.ts", import.meta.url));

const UNDICI: ReleaseAgeException = {
  package: "undici",
  version: "7.16.1",
  advisory: "GHSA-2222-3333-4444",
  label: RELEASE_AGE_LABEL,
  agedOn: "2026-10-19",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository root of the test's own, with this pnpm-workspace.yaml and, unless undefined, this list of exceptions. */
function repository(exclusions: readonly string[], exceptions: readonly unknown[] | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "tiehall-release-age-"));
  roots.push(root);
  const excluded = exclusions.length === 0 ? "" : `minimumReleaseAgeExclude:\n${exclusions.map((entry) => `  - "${entry}"`).join("\n")}\n`;
  writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - packages/*\nminimumReleaseAge: 10080\n${excluded}strictDepBuilds: true\n`);
  if (exceptions !== undefined) {
    mkdirSync(join(root, "tools", "repo-checks"), { recursive: true });
    writeFileSync(join(root, RELEASE_AGE_EXCEPTIONS), `${JSON.stringify({ exceptions }, null, 2)}\n`);
  }
  return root;
}

/** The details of the violations of the release-age rule, as the workflow check gives them. */
const detailsOf = (root: string, today: string) => releaseAgeViolations(root, today).map(({ file, detail }) => `${file}: ${detail}`);

describe("an exclusion from the release age", () => {
  it("passes when it names one package at one exact version that the list records with its advisory, its label and the day it turns 7 days old", () => {
    const root = repository(["undici@7.16.1"], [UNDICI]);
    expect(detailsOf(root, "2026-10-14")).toEqual([]);
    expect(releaseAgeExceptions(root)).toEqual([UNDICI]);
  });

  it("passes on the day the version turns 7 days old, and fails once that day has passed, until the exclusion and its record go", () => {
    const root = repository(["undici@7.16.1"], [UNDICI]);
    expect(detailsOf(root, "2026-10-19")).toEqual([]);
    expect(detailsOf(root, "2026-10-20")).toEqual([
      "pnpm-workspace.yaml: undici@7.16.1 turned 7 days old on 2026-10-19, so it needs no exception any more: remove its exclusion from the release age and its record",
    ]);
  });

  it("fails when it names a package without its exact version, a range or several versions", () => {
    for (const entry of ["undici", "undici@^7.16.1", "undici@7.16.1 || 7.16.2", "@scope/*", "undici@7"]) {
      const details = detailsOf(repository([entry], [UNDICI]), "2026-10-14");
      expect(details, entry).toContainEqual(
        `pnpm-workspace.yaml: the exclusion ${JSON.stringify(entry)} must name one package at one exact version, such as undici@7.16.1`,
      );
    }
    // A scoped package at an exact version is one package at one version.
    expect(detailsOf(repository(["@octokit/request@10.0.16"], [{ ...UNDICI, package: "@octokit/request", version: "10.0.16" }]), "2026-10-14")).toEqual([]);
  });

  it("fails when the list does not record it, or records it without an advisory, with another label or with no day", () => {
    expect(detailsOf(repository(["undici@7.16.1"], undefined), "2026-10-14")).toEqual([
      `pnpm-workspace.yaml: undici@7.16.1 is excluded from the release age, but ${RELEASE_AGE_EXCEPTIONS} records no such exception`,
    ]);
    expect(detailsOf(repository(["undici@7.16.1"], []), "2026-10-14")).toEqual([
      `pnpm-workspace.yaml: undici@7.16.1 is excluded from the release age, but ${RELEASE_AGE_EXCEPTIONS} records no such exception`,
    ]);
    for (const [broken, problem] of [
      [{ ...UNDICI, advisory: "" }, "the advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345"],
      [{ ...UNDICI, label: "api-breaking" }, `the label ${RELEASE_AGE_LABEL}`],
      [{ ...UNDICI, agedOn: "next week" }, "the day the version turns 7 days old, such as 2026-10-19"],
    ] as const) {
      expect(detailsOf(repository(["undici@7.16.1"], [broken]), "2026-10-14"), problem).toContainEqual(
        `${RELEASE_AGE_EXCEPTIONS}: the exception for undici@7.16.1 must record ${problem}`,
      );
    }
  });

  it("fails for a record of an exception that pnpm-workspace.yaml does not make, so the list holds only the exceptions in force", () => {
    expect(detailsOf(repository([], [UNDICI]), "2026-10-14")).toEqual([
      `${RELEASE_AGE_EXCEPTIONS}: it records an exception for undici@7.16.1, which pnpm-workspace.yaml does not exclude from the release age`,
    ]);
  });

  it("fails the workflow check, which CI runs as pnpm check:workflows", () => {
    const root = repository(["undici"], [UNDICI]);
    expect(checkWorkflows(root).map(({ rule }) => rule)).toContain("release-age");
    const run = spawnSync(process.execPath, [checkWorkflowsScript, root], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[release-age]");
  });

  it("passes on the real tree, whose list records every exclusion it makes", () => {
    expect(releaseAgeViolations(repoRoot, new Date().toISOString().slice(0, 10))).toEqual([]);
    const workspace = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as { minimumReleaseAge?: number };
    expect(workspace.minimumReleaseAge).toBe(10080);
  });
});

describe("the label step of a pull request", () => {
  it("requires the release-age-exception label on a pull request that adds an exclusion, and on no other", () => {
    expect(releaseAgeLabelProblems({ base: [], revision: ["undici@7.16.1"], labels: [] })).toEqual([
      `This pull request excludes undici@7.16.1 from the 7-day release age, which only a reviewed pull request with the ${RELEASE_AGE_LABEL} label may do.`,
    ]);
    expect(releaseAgeLabelProblems({ base: [], revision: ["undici@7.16.1"], labels: ["api-breaking"] })).toHaveLength(1);
    expect(releaseAgeLabelProblems({ base: [], revision: ["undici@7.16.1"], labels: [RELEASE_AGE_LABEL] })).toEqual([]);
    // Keeping or removing an exclusion needs no label.
    expect(releaseAgeLabelProblems({ base: ["undici@7.16.1"], revision: ["undici@7.16.1"], labels: [] })).toEqual([]);
    expect(releaseAgeLabelProblems({ base: ["undici@7.16.1"], revision: [], labels: [] })).toEqual([]);
  });

  it("runs as a script against the pull request's merge base, with the labels from the environment", () => {
    const root = repository([], []);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    };
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "maintainers@example.com");
    git("config", "user.name", "Maintainers");
    git("config", "commit.gpgsign", "false");
    git("add", "--all");
    git("commit", "--quiet", "--message", "base");
    git("checkout", "--quiet", "-b", "fix");
    writeFileSync(join(root, "pnpm-workspace.yaml"), readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").replace("strictDepBuilds", 'minimumReleaseAgeExclude:\n  - "undici@7.16.1"\nstrictDepBuilds'));
    git("commit", "--quiet", "--all", "--message", "fix");
    const run = (labels: string[]) =>
      spawnSync(process.execPath, [labelScript, "main", "--root", root], { encoding: "utf8", env: { ...process.env, PR_LABELS: JSON.stringify(labels) } });
    const refused = run([]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`which only a reviewed pull request with the ${RELEASE_AGE_LABEL} label may do`);
    expect(run([RELEASE_AGE_LABEL]).status).toBe(0);
  });

  it("is a step of the API-compatibility workflow, which runs on every pull request and again when a label changes", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/api-compatibility.yml"), "utf8")) as {
      on: { pull_request: { types: string[] } };
      jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
    };
    expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "synchronize", "labeled", "unlabeled"]));
    const steps = Object.values(workflow.jobs).flatMap(({ steps }) => steps);
    const step = steps.find(({ run }) => run?.trim() === "node tools/repo-checks/src/check-release-age-label.ts");
    expect(step?.env).toEqual({ BASE_REF: "${{ github.base_ref }}", PR_LABELS: "${{ toJSON(github.event.pull_request.labels.*.name) }}" });
  });
});

describe("the release notes", () => {
  const digest = `sha256:${"a1".repeat(32)}`;
  const notesWith = (exceptions: readonly ReleaseAgeException[]) =>
    renderReleaseNotes({
      root: repoRoot,
      version: "1.3.0",
      image: parseReleaseImage(`ghcr.io/acme/tiehall:1.3.0@${digest}`, "1.3.0"),
      repository: "https://github.com/acme/tiehall",
      commit: "0123456789abcdef0123456789abcdef01234567",
      api: { version: "1.3.0", date: "2026-11-02", apiVersion: "0.3.0", entries: [], changes: [] },
      contractSteps: [],
      noSkip: [],
      releaseAgeExceptions: exceptions,
    }).replace(/\s+/g, " ");

  it("list the exceptions to the release age the release carries, each with its advisory and the day it turns 7 days old", () => {
    const notes = notesWith([UNDICI]);
    expect(notes).toContain("## Exceptions to the release age");
    expect(notes).toContain(
      "- `undici` 7.16.1, the version advisory GHSA-2222-3333-4444 names as fixed, taken before it turns 7 days old on 2026-10-19",
    );
  });

  it("say that a release carries no exception when it has none", () => {
    expect(notesWith([])).toContain("This release takes no dependency younger than the 7-day release age.");
  });
});
