import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The CI job that typechecks and tests every pull request and push to main.
// On GitHub's 2-core runners the suite outgrew 20 minutes, then 40, so it runs
// in parallel shards, each a slice of the test files (`vitest run --shard`),
// next to a typecheck job. One job keeps the name the branch protection
// requires, "Typecheck and test", and passes only when the typecheck and
// every shard passed, so a failing or cancelled shard still fails it.

const root = fileURLToPath(new URL("../../../", import.meta.url));

type Mapping = Record<string, unknown>;
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: Mapping };
  steps?: Mapping[];
}

const workflow = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const jobs = Object.entries(workflow.jobs);
const runs = (job: Job) => (job.steps ?? []).map((step) => (typeof step["run"] === "string" ? step["run"] : "")).join("\n");
const needsOf = (job: Job) => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

describe("CI's typecheck and test", () => {
  const testing = jobs.filter(([, job]) => /\bpnpm test\b/.test(runs(job)));

  it("runs the suite in parallel shards, each one slice of the test files, all of them run whatever one does", () => {
    expect(testing).toHaveLength(1);
    const [[, shards]] = testing as [[string, Job]];
    const values = shards.strategy?.matrix?.["shard"];
    expect(Array.isArray(values)).toBe(true);
    const count = (values as unknown[]).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(values).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(runs(shards)).toContain(`pnpm test --shard=\${{ matrix.shard }}/${count}`);
    expect(shards.strategy?.["fail-fast"]).toBe(false);
    expect(shards["timeout-minutes"]).toBeLessThanOrEqual(40);
  });

  it("keeps the required name on one job that needs the typecheck and the shards, and passes only when each passed", () => {
    const required = jobs.filter(([, job]) => job.name === "Typecheck and test");
    expect(required).toHaveLength(1);
    const [[, aggregate]] = required as [[string, Job]];
    const needed = needsOf(aggregate);
    const typecheck = jobs.find(([, job]) => /\bpnpm -r typecheck\b/.test(runs(job)));
    expect(typecheck).toBeDefined();
    expect(needed.sort()).toEqual([typecheck![0], testing[0]![0]].sort());
    // Without always(), a failed shard would skip this job, and GitHub counts a skipped required check as passed.
    expect(aggregate.if).toBe("always()");
    const script = JSON.stringify(aggregate.steps);
    for (const job of needed) expect(script).toContain(`needs.${job}.result`);
    expect(runs(aggregate)).toMatch(/= success/);
  });
});

// The screenshot tests (web-ui: Pages work at phone width; web-ui: Pages are accessible; design.md, Design: Testing;
// D57 (7), (8)) save one screenshot per page, size and scheme under test-results/screens/, which git ignores, and no
// test compares pixels with a stored image, so CI keeps them for review: each shard uploads the folder as an artifact of
// its own, through an action pinned by its commit SHA, with no more permissions than the job's own, and a shard whose
// slice of the test files holds no screenshot test uploads nothing and does not fail.
describe("CI's screenshots", () => {
  it("are uploaded by each shard as screens-<shard>, whatever its tests did, with an action pinned by its commit SHA", () => {
    const [[, shards]] = jobs.filter(([, job]) => /\bpnpm test\b/.test(runs(job))) as [[string, Job]];
    const uploads = (shards.steps ?? []).filter((step) => typeof step["uses"] === "string" && step["uses"].startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    const [upload] = uploads as [Mapping];
    expect(upload["uses"]).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload["if"]).toBe("always()");
    expect(upload["with"]).toEqual({ name: "screens-${{ matrix.shard }}", path: "test-results/screens/", "if-no-files-found": "ignore" });
    // After the tests, so it holds what they saved.
    const steps = shards.steps ?? [];
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.findIndex((step) => typeof step["run"] === "string" && /\bpnpm test\b/.test(step["run"])));
    // Uploading an artifact needs no permission of the job's token: the job reads the repository's contents and nothing more.
    expect((shards as Job & { permissions?: unknown }).permissions).toEqual({ contents: "read" });
  });

  it("are saved where git ignores them, so the source-citation check never reads them", () => {
    const ignored = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
    expect(ignored).toContain("test-results/");
  });
});

// The coverage checks read a mirrored list as the newest change that modifies it words it, by when commits added the
// changes (plan.ts), and refuse a shallow clone once two changes in progress modify one list, since a checkout at depth
// 1 holds one commit, which seems to add every change at once. The checks run in jobs of their own and, on the real
// tree, in the suite's tests, so each job that runs them checks out the whole history.
describe("CI's checkouts for the coverage checks", () => {
  const PLAN_READERS = [/\bpnpm test\b/, /\bpnpm check:confirmations\b/, /\bpnpm check:security-events\b/];

  it("fetch the whole history in every job that runs the suite or a check that reads the plan", () => {
    const readers = jobs.filter(([, job]) => PLAN_READERS.some((pattern) => pattern.test(runs(job))));
    expect(readers.map(([name]) => name).sort()).toEqual(["confirmation-coverage", "security-event-coverage", "test-shard"]);
    for (const [name, job] of readers) {
      const checkouts = (job.steps ?? []).filter((step) => typeof step["uses"] === "string" && step["uses"].startsWith("actions/checkout@"));
      expect(checkouts, name).toHaveLength(1);
      expect((checkouts[0]!["with"] as Mapping | undefined)?.["fetch-depth"], name).toBe(0);
    }
  });
});

// agent-surfaces: The CLI package. The CLI says it runs on Node.js 22 or later, while the repository builds and tests
// on the version in .node-version: one job builds its bundle and runs its tests on Node.js 22, so the claim is tried.
describe("CI's run of the CLI on Node.js 22", () => {
  it("is a job that builds the CLI's bundle and runs its tests on Node.js 22", () => {
    const onNode22 = jobs.filter(([, job]) =>
      (job.steps ?? []).some((step) => typeof step["uses"] === "string" && step["uses"].startsWith("actions/setup-node@") && String((step["with"] as Mapping | undefined)?.["node-version"]) === "22"),
    );
    expect(onNode22).toHaveLength(1);
    const [[, job]] = onNode22 as [[string, Job]];
    expect(runs(job)).toContain("pnpm --filter tiehall build");
    expect(runs(job)).toMatch(/pnpm vitest run --project tiehall\b/);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
  });
});
