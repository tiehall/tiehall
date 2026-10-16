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
//
// A record may rest, in place of an advisory, on a maintainer's recorded
// answer that calls for the update and the supply-chain review of the
// version, with the same label, the same day and the same listing in the
// release notes (release-age-maintainer-exception: design.md, Decisions this
// change rests on; Technical decisions: T1).

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

// The record of an update that a maintainer's recorded answer calls for, as the
// answer of 2026-10-16 calls for Better Auth 1.7.10.
const BETTER_AUTH: ReleaseAgeException = {
  package: "better-auth",
  version: "1.7.10",
  answer: { day: "2026-10-16", recordedIn: "release-age-maintainer-exception, design.md: Decisions this change rests on" },
  review: {
    day: "2026-10-16",
    recordedIn: "release-age-maintainer-exception, design.md: Context",
    compared: "every published file of 1.7.5 against 1.7.10: no eval, new Function or child_process, no new network call, no minified code",
    provenance: "each tarball's SHA-512 is the registry's, and npm audit signatures verifies the signatures and the provenance of the library's release.yml",
    scripts: "no install script",
    dependencies: "no new dependency; better-call moves to 1.4.2",
  },
  label: RELEASE_AGE_LABEL,
  agedOn: "2026-10-22",
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

describe("an exclusion for an update a maintainer's recorded answer calls for", () => {
  /** The details of the violations of a repository that excludes better-auth@1.7.10 with this record, on 2026-10-17. */
  const detailsWith = (record: unknown) => detailsOf(repository(["better-auth@1.7.10"], [record]), "2026-10-17");
  /** What the list reports about the record of better-auth@1.7.10. */
  const must = (problem: string) => `${RELEASE_AGE_EXCEPTIONS}: the exception for better-auth@1.7.10 must record ${problem}`;
  const { answer, review, ...withoutBasis } = BETTER_AUTH;

  it("passes when its record names, in place of an advisory, the answer and the supply-chain review of the version, with its label and its day", () => {
    const root = repository(["better-auth@1.7.10"], [BETTER_AUTH]);
    expect(detailsOf(root, "2026-10-17")).toEqual([]);
    expect(releaseAgeExceptions(root)).toEqual([BETTER_AUTH]);
    // An advisory's record and an answer's sit side by side in one list.
    expect(detailsOf(repository(["better-auth@1.7.10", "undici@7.16.1"], [BETTER_AUTH, UNDICI]), "2026-10-17")).toEqual([]);
  });

  it("passes on the day the version turns 7 days old, and fails once that day has passed, as an advisory's exception does", () => {
    const root = repository(["better-auth@1.7.10"], [BETTER_AUTH]);
    expect(detailsOf(root, "2026-10-22")).toEqual([]);
    expect(detailsOf(root, "2026-10-23")).toEqual([
      "pnpm-workspace.yaml: better-auth@1.7.10 turned 7 days old on 2026-10-22, so it needs no exception any more: remove its exclusion from the release age and its record",
    ]);
  });

  it("fails a record that names neither an advisory nor an answer, and one that names both", () => {
    expect(detailsWith(withoutBasis)).toEqual([
      must(
        "the advisory that names the version as fixed, such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345, or the maintainer's answer that calls for it and the supply-chain review of the version",
      ),
    ]);
    expect(detailsWith({ ...BETTER_AUTH, advisory: "GHSA-2222-3333-4444" })).toEqual([
      must("either the advisory that names the version as fixed or the maintainer's answer that calls for it, not both"),
    ]);
  });

  it("fails an answer without its day or without where it is recorded, and a review without its answer", () => {
    expect(detailsWith({ ...BETTER_AUTH, answer: { day: "yesterday", recordedIn: "release-age-maintainer-exception" } })).toEqual([
      must("the day the maintainer's answer that calls for it was given, such as 2026-10-16"),
    ]);
    expect(detailsWith({ ...BETTER_AUTH, answer: { day: "2026-10-16", recordedIn: " " } })).toEqual([must("where the maintainer's answer that calls for it is recorded")]);
    expect(detailsWith({ ...withoutBasis, review })).toEqual([
      must("the maintainer's answer that calls for it, with the day it was given and where it is recorded"),
    ]);
  });

  it("fails an answer without the supply-chain review of the version, and a review without one of its parts", () => {
    expect(detailsWith({ ...withoutBasis, answer })).toEqual([
      must("the supply-chain review of the version, with its day, where it is recorded, what it compared, the version's provenance, its install scripts and its dependencies"),
    ]);
    for (const [part, problem] of [
      ["day", "the day of the supply-chain review of the version, such as 2026-10-16"],
      ["recordedIn", "where the supply-chain review of the version is recorded"],
      ["compared", "what the supply-chain review of the version compared"],
      ["provenance", "the version's provenance, as the supply-chain review found it"],
      ["scripts", "the version's install scripts, as the supply-chain review found them"],
      ["dependencies", "the version's dependencies, as the supply-chain review found them"],
    ] as const) {
      const { [part]: _left, ...rest } = review ?? {};
      expect(detailsWith({ ...BETTER_AUTH, review: rest }), part).toEqual([must(problem)]);
      expect(detailsWith({ ...BETTER_AUTH, review: { ...review, [part]: "" } }), part).toEqual([must(problem)]);
    }
  });

  it("fails a record without the label, as it fails an advisory's", () => {
    expect(detailsWith({ ...BETTER_AUTH, label: "" })).toEqual([must(`the label ${RELEASE_AGE_LABEL}`)]);
    expect(detailsWith({ ...BETTER_AUTH, label: "api-breaking" })).toEqual([must(`the label ${RELEASE_AGE_LABEL}`)]);
  });

  it("fails the workflow check, which CI runs as pnpm check:workflows", () => {
    const root = repository(["better-auth@1.7.10"], [{ ...withoutBasis, answer }]);
    expect(checkWorkflows(root).map(({ rule }) => rule)).toContain("release-age");
    const run = spawnSync(process.execPath, [checkWorkflowsScript, root], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must record the supply-chain review of the version");
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
    // It says what an exclusion may take: an advisory's fixed version, or the version a maintainer's answer calls for.
    expect(refused.stderr).toContain("exactly the version an advisory names as fixed for a fixable HIGH or CRITICAL finding of the image scan");
    expect(refused.stderr).toContain("or the version a maintainer's recorded answer calls for, after a supply-chain review of it");
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

  it("list an update a maintainer's answer calls for with the answer, the review and the day it turns 7 days old, beside an advisory's", () => {
    const notes = notesWith([BETTER_AUTH, UNDICI]);
    expect(notes).toContain(
      "This release takes these versions sooner, through a reviewed pull request with the `release-age-exception` label, each the version an advisory names as fixed, " +
        "for a vulnerability the image scan found, or the version a maintainer's recorded answer calls for, after a supply-chain review of it:",
    );
    expect(notes).toContain(
      "- `better-auth` 1.7.10, which the maintainer's answer of 2026-10-16 calls for (release-age-maintainer-exception, design.md: Decisions this change rests on), " +
        "after a supply-chain review of 2026-10-16 (release-age-maintainer-exception, design.md: Context), taken before it turns 7 days old on 2026-10-22",
    );
    expect(notes).toContain("- `undici` 7.16.1, the version advisory GHSA-2222-3333-4444 names as fixed, taken before it turns 7 days old on 2026-10-19");
  });

  it("say that a release carries no exception when it has none", () => {
    expect(notesWith([])).toContain("This release takes no dependency younger than the 7-day release age.");
  });
});
