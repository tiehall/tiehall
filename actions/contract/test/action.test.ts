import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CLI_PIN } from "../src/action.ts";
import { archiveUrl, OASDIFF } from "../src/oasdiff.ts";
import { OASDIFF_FIXTURES } from "../src/oasdiff-fixtures.ts";
import { archiveHolding, INPUTS, runActionWith, SPEC } from "./support/runner.ts";

// The contract Action (contract-changes: The contract Action;
// contract-changes: Contract diffs run only where the specs already are;
// design.md, Design rules: Contract changes; design.md, Technical decisions:
// T12). It runs in the provider's CI on pull_request events of the types
// opened, synchronize, reopened and ready_for_review, and skips drafts unless
// the workflow says otherwise. It installs the pinned oasdiff, whose release
// archive it checks against the pinned SHA-256 before anything in it runs,
// computes the breaking changes and the changelog of the API's document
// between the commit the pull request branched off its base branch and its
// head, so they are the pull request's own, and reports them with the pinned
// tiehall CLI's `contract report`. It uploads no document, and it fails the
// check for breaking changes only when an input asks for it. Here the Action
// runs in this process with a runner of the test's own: git and oasdiff run
// for real on a repository whose pull request changes the document as a
// fixture pair of task 23.1 does, and `npx` stands in for the pinned CLI.

const scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-action-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs git in a folder, as a fixed author, and throws when it fails. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", ["-c", "user.name=Provider CI", "-c", "user.email=ci@acme.example", ...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** The recorded changelog of a fixture pair. */
const recordedChangelog = (pair: string) => readFileSync(join(OASDIFF_FIXTURES, pair, "changelog.json"), "utf8");

describe("the events it runs on", () => {
  it.each(["opened", "synchronize", "reopened", "ready_for_review"])("reports a pull request %s", async (action) => {
    const run = await runActionWith(scratch, { action });
    expect(run.code).toBe(0);
    expect(run.reports).toHaveLength(1);
  });

  it.each(["edited", "closed", "labeled", "converted_to_draft"])("skips a pull request %s, and downloads and reports nothing", async (action) => {
    const run = await runActionWith(scratch, { action });
    expect(run.code).toBe(0);
    expect(run.reports).toEqual([]);
    expect(run.fetched).toEqual([]);
    expect(run.stdout).toMatch(/^::notice title=Contract check skipped::/m);
  });

  it("skips an event that is not a pull request's, such as a push", async () => {
    const run = await runActionWith(scratch, { eventName: "push" });
    expect(run.code).toBe(0);
    expect(run.reports).toEqual([]);
    expect(run.stdout).toMatch(/^::notice title=Contract check skipped::.*pull_request events.*push/m);
  });
});

describe("a draft pull request", () => {
  it("is skipped by default: the Action sends no report", async () => {
    const run = await runActionWith(scratch, { draft: true });
    expect(run.code).toBe(0);
    expect(run.reports).toEqual([]);
    expect(run.fetched).toEqual([]);
    expect(run.stdout).toMatch(/^::notice title=Contract check skipped::Pull request #310 is a draft/m);
  });

  it("is reported once it is marked ready for review", async () => {
    const run = await runActionWith(scratch, { action: "ready_for_review", draft: false });
    expect(run.reports).toHaveLength(1);
  });

  it("is reported when the workflow turns the default off with include-drafts", async () => {
    const run = await runActionWith(scratch, { draft: true, inputs: { "include-drafts": "true" } });
    expect(run.code).toBe(0);
    expect(run.reports).toHaveLength(1);
  });
});

describe("the pinned diff engine", () => {
  it("is the pinned oasdiff release, downloaded from GitHub", async () => {
    const run = await runActionWith(scratch);
    const archive = OASDIFF.archives[`${process.platform}-${process.arch}`];
    expect(archive).toBeDefined();
    expect(run.fetched).toEqual([archiveUrl(OASDIFF, archive?.file ?? "")]);
    expect(run.reports[0]?.args).toContain(OASDIFF.version);
  });

  it("is not run from an archive whose SHA-256 is not the pinned one, and the Action sends no report", async () => {
    const marker = join(scratch, "tampered-binary-ran");
    const tampered = archiveHolding(scratch, `#!/bin/sh\ntouch '${marker}'\necho '[]'\n`);

    const run = await runActionWith(scratch, { archive: tampered });

    expect(run.code).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(run.execs.filter(({ file }) => file !== "git")).toEqual([]);
    expect(run.reports).toEqual([]);
    expect(run.stdout).toMatch(/^::error title=oasdiff not verified::.*not the pinned/m);
  });
});

describe("the changes it computes", () => {
  it.each(["breaking", "warning", "informational", "unchanged"])("hands the CLI oasdiff's changelog of the %s pair, as recorded", async (pair) => {
    const run = await runActionWith(scratch, { pair: pair as never });
    expect(run.code).toBe(0);
    expect(run.reports[0]?.changes).toBe(recordedChangelog(pair));
  });

  it("writes the breaking changes and their counts to the job summary", async () => {
    const run = await runActionWith(scratch, { pair: "breaking" });
    expect(run.summary).toContain("## Tiehall contract check: payments-api");
    expect(run.summary).toContain("2 breaking changes (ERR), 1 potentially breaking change (WARN) and 2 other changes (INFO)");
    expect(run.summary).toContain("[request-parameter-became-required]");
    expect(run.summary).toContain("[response-required-property-removed]");
    expect(run.outputs).toMatchObject({ "breaking-changes": "2", warnings: "1", reported: "true" });
  });

  it("reports no change for a pull request that adds the document", async () => {
    const run = await runActionWith(scratch, { pair: "added" });
    expect(run.code).toBe(0);
    expect(run.reports[0]?.changes).toBe("[]");
    expect(run.summary).toContain(`adds ${SPEC}`);
  });

  it("compares the head with the commit the pull request branched off, so what the base branch changed since is not the pull request's", async () => {
    // The pull request changes only the README; after it branched off, main changed the document as the breaking pair's revision undoes.
    const path = mkdtempSync(join(scratch, "repository-moved-base-"));
    git(path, "init", "--quiet", "--initial-branch=main");
    mkdirSync(join(path, "openapi"));
    copyFileSync(join(OASDIFF_FIXTURES, "breaking", "revision.yaml"), join(path, SPEC));
    writeFileSync(join(path, "README.md"), "The payments service.\n");
    git(path, "add", "--all");
    git(path, "commit", "--quiet", "--message", "Where the pull request branches off");
    const branchPoint = git(path, "rev-parse", "HEAD");
    git(path, "checkout", "--quiet", "-b", "readme-only");
    writeFileSync(join(path, "README.md"), "The payments service, which takes payments.\n");
    git(path, "commit", "--quiet", "--all", "--message", "The pull request");
    const head = git(path, "rev-parse", "HEAD");
    git(path, "checkout", "--quiet", "main");
    copyFileSync(join(OASDIFF_FIXTURES, "breaking", "base.yaml"), join(path, SPEC));
    git(path, "commit", "--quiet", "--all", "--message", "main moves on");
    const base = git(path, "rev-parse", "HEAD");

    const run = await runActionWith(scratch, { repository: { path, base, head }, inputs: { "fail-on-breaking": "true" } });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.reports[0]?.changes ?? "")).toEqual([]);
    expect(run.outputs["breaking-changes"]).toBe("0");
    expect(run.summary).toContain(`compared ${SPEC} at ${branchPoint.slice(0, 7)}, where new-payment-fields branched off main, with new-payment-fields (${head.slice(0, 7)})`);
  });

  it("reports nothing, failing open with a warning, when the head commit has no document at the path the spec input names", async () => {
    const run = await runActionWith(scratch, { inputs: { spec: "openapi/billing.yaml" } });
    expect(run.code).toBe(0);
    expect(run.reports).toEqual([]);
    expect(run.stdout).toMatch(/^::warning title=Document not found::/m);
    expect(run.summary).toContain("no report was sent");
  });
});

describe("the report", () => {
  it("is sent with the pinned tiehall CLI's contract report, with the changelog and the engine's version", async () => {
    const run = await runActionWith(scratch);
    const [report] = run.reports;
    const changes = report?.args[report.args.indexOf("--changes") + 1];
    expect(report?.args).toEqual([
      "--yes",
      `tiehall@${CLI_PIN.version}`,
      "contract",
      "report",
      "--install",
      INPUTS["install-url"],
      "--api",
      INPUTS.api,
      "--changes",
      changes,
      "--engine-version",
      OASDIFF.version,
      "--json",
    ]);
    expect(run.outputs["report-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("pins the CLI of this repository", () => {
    const cli = JSON.parse(readFileSync(new URL("../../../packages/cli/package.json", import.meta.url), "utf8")) as { name: string; version: string };
    expect(CLI_PIN).toEqual({ package: cli.name, version: cli.version });
  });

  it("uploads no document: it fetches only the engine, hands the CLI only the changelog, and leaves no document behind", async () => {
    const run = await runActionWith(scratch);
    const document = readFileSync(join(OASDIFF_FIXTURES, "breaking", "revision.yaml"), "utf8");
    expect(run.fetched.every((url) => url.startsWith("https://github.com/oasdiff/oasdiff/releases/download/"))).toBe(true);
    expect(new Set(run.execs.map(({ file }) => (file.endsWith("/oasdiff") ? "oasdiff" : file)))).toEqual(new Set(["git", "oasdiff", "npx"]));
    const [report] = run.reports;
    expect(report?.args.join(" ")).not.toContain(SPEC);
    expect(report?.args.join(" ")).not.toContain("openapi: 3.1.0");
    expect(report?.changes).not.toContain(document.slice(0, 200));
    expect(run.leftInTemp).toEqual([]);
  });
});

describe("the check", () => {
  it("is not marked failed for breaking changes by default", async () => {
    const run = await runActionWith(scratch, { pair: "breaking" });
    expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/^::error/m);
  });

  it("is marked failed for breaking changes when the workflow sets fail-on-breaking", async () => {
    const run = await runActionWith(scratch, { pair: "breaking", inputs: { "fail-on-breaking": "true" } });
    expect(run.code).toBe(1);
    expect(run.reports).toHaveLength(1);
    expect(run.stdout).toMatch(/^::error title=Breaking changes::2 breaking changes to payments-api/m);
  });

  it("is not marked failed for WARN-level changes alone, even with fail-on-breaking", async () => {
    const run = await runActionWith(scratch, { pair: "warning", inputs: { "fail-on-breaking": "true" } });
    expect(run.code).toBe(0);
  });

  it("refuses a fail-on-breaking that is neither true nor false, failing open with a warning", async () => {
    const run = await runActionWith(scratch, { inputs: { "fail-on-breaking": "sometimes" } });
    expect(run.code).toBe(0);
    expect(run.reports).toEqual([]);
    expect(run.stdout).toMatch(/^::warning title=Input not valid::The input fail-on-breaking is true or false/m);
  });
});

describe("action.yml", () => {
  const action = parse(readFileSync(new URL("../action.yml", import.meta.url), "utf8")) as {
    runs: { using: string; main: string };
    inputs: Record<string, { required?: boolean; default?: string }>;
  };

  it("runs the Action's source on the runner's Node.js 24, with nothing to install", () => {
    expect(action.runs.using).toBe("node24");
    expect(existsSync(new URL(`../${action.runs.main}`, import.meta.url))).toBe(true);
  });

  it("starts src/main.ts, which Node.js runs as it is, with no build", () => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(`../${action.runs.main}`, import.meta.url))], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", GITHUB_EVENT_NAME: "push" },
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("::notice title=Contract check skipped::The contract Action reports on pull_request events, and this run's event is push.\n");
  });

  it("takes the install's URL, the API and its document, and the two switches, off by default", () => {
    expect(action.inputs["install-url"]?.required).toBe(true);
    expect(action.inputs["api"]?.required).toBe(true);
    expect(action.inputs["spec"]?.required).toBe(true);
    expect(action.inputs["fail-on-breaking"]?.default).toBe("false");
    expect(action.inputs["include-drafts"]?.default).toBe("false");
  });
});
