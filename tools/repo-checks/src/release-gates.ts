import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// The release's gates (self-host-install: Upgrades apply migrations before the
// app starts; public-api: Each operation carries a stability level; design.md,
// Technical decisions: T13 and T17). A release is published only after the
// fresh-install, upgrade, backup-and-restore, polling-mode and egress tests
// have passed on its image, and after the release check of stability levels
// has passed on its documents: a failure in any of them stops the release
// before anything is pushed or published.
//
// The check reads the release workflow and the workflows of this repository
// it calls, finds each step that runs a gate, and works out, as GitHub runs a
// workflow, which of the release workflow's jobs would still run if that step
// failed: a job runs when every job it needs succeeded, unless its condition
// names always(), failure() or cancelled(), which run it whatever they did; a
// job that calls a workflow fails when a job of that workflow fails; and a
// failing step fails its job unless it, or its job, may continue on error. A
// condition on the gate's own step might skip it, and the check counts it as
// skipped. Every job of the release workflow that holds a write permission
// pushes or publishes, so none may run after a gate fails.

export interface Gate {
  /** The gate's name, as the check reports it. */
  name: string;
  /** The command of the step that runs it. */
  command: RegExp;
}

export const RELEASE_GATES: readonly Gate[] = [
  { name: "the fresh-install test", command: /\bpnpm test:install\b[^\n]*\bfresh-install\b/ },
  { name: "the upgrade test", command: /\bpnpm test:install\b[^\n]*\bupgrade\b/ },
  { name: "the backup-and-restore test", command: /\bpnpm test:install\b[^\n]*\bbackup\b/ },
  { name: "the polling-mode test", command: /\bpnpm test:install\b[^\n]*\bpolling\b/ },
  { name: "the egress test", command: /\bpnpm test:install\b[^\n]*\begress\b/ },
  { name: "the release check of stability levels", command: /\bpnpm release:check-stability\b/ },
];

/** The release workflow, in .github/workflows. */
export const RELEASE_WORKFLOW = "release.yml";

/** Where a gate runs: a step of a job of a workflow file. */
export interface Site {
  file: string;
  job: string;
  /** The step's index in its job, from 0. */
  step: number;
}

type Result = "success" | "failure" | "skipped";
type Mapping = Record<string, unknown>;

const WORKFLOWS = join(".github", "workflows");
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/;
/** A status function that runs a job, or a step, whatever the jobs it needs did. */
const RUNS_WHATEVER = /\b(?:always|failure|cancelled)\s*\(/;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jobsOf(root: string, file: string): Map<string, Mapping> {
  const path = join(root, WORKFLOWS, file);
  if (!existsSync(path)) return new Map();
  const workflow = parse(readFileSync(path, "utf8")) as unknown;
  const jobs = isMapping(workflow) && isMapping(workflow["jobs"]) ? workflow["jobs"] : {};
  return new Map(Object.entries(jobs).map(([id, job]) => [id, isMapping(job) ? job : {}]));
}

function stepsOf(job: Mapping): Mapping[] {
  return Array.isArray(job["steps"]) ? job["steps"].filter(isMapping) : [];
}

function needsOf(job: Mapping): string[] {
  const needs = job["needs"];
  return typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs.filter((each): each is string => typeof each === "string") : [];
}

/** Whether a continue-on-error value may let a failure through: anything but false, since an expression may be true. */
function mayContinue(value: unknown): boolean {
  return value !== undefined && value !== false && value !== "false";
}

/** The local workflows a workflow calls, itself first, each once. */
function reachable(root: string, file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const called = [...jobsOf(root, file).values()]
    .map((job) => (typeof job["uses"] === "string" ? LOCAL_WORKFLOW.exec(job["uses"])?.[1] : undefined))
    .filter((each): each is string => each !== undefined);
  return [file, ...called.flatMap((each) => reachable(root, each, seen))];
}

/** The steps that run a gate, in the release workflow and the local workflows it calls. */
export function gateSites(root: string, gate: Gate): Site[] {
  return reachable(root, RELEASE_WORKFLOW).flatMap((file) =>
    [...jobsOf(root, file)].flatMap(([job, definition]) =>
      stepsOf(definition).flatMap((step, index) => (typeof step["run"] === "string" && gate.command.test(step["run"]) ? [{ file, job, step: index }] : [])),
    ),
  );
}

/** The result of each job of a workflow when the step at the site fails, as GitHub would run it. */
function run(root: string, file: string, failing: Site, calls: string[] = []): Map<string, Result> {
  const jobs = jobsOf(root, file);
  const results = new Map<string, Result>();
  const resultOf = (id: string, path: string[]): Result => {
    const known = results.get(id);
    if (known !== undefined) return known;
    const job = jobs.get(id);
    // A job that needs a job the workflow does not have, or needs itself, never runs.
    if (job === undefined || path.includes(id)) return "skipped";
    const needed = needsOf(job).map((each) => resultOf(each, [...path, id]));
    const condition = job["if"];
    const runs = (typeof condition === "string" && RUNS_WHATEVER.test(condition)) || needed.every((result) => result === "success");
    let result: Result = "skipped";
    if (runs) {
      const called = typeof job["uses"] === "string" ? LOCAL_WORKFLOW.exec(job["uses"])?.[1] : undefined;
      let failed = false;
      if (called !== undefined && !calls.includes(called)) {
        failed = [...run(root, called, failing, [...calls, file]).values()].includes("failure");
      } else if (failing.file === file && failing.job === id) {
        const step = stepsOf(job)[failing.step] ?? {};
        failed = step["if"] === undefined && !mayContinue(step["continue-on-error"]);
      }
      result = failed && !mayContinue(job["continue-on-error"]) ? "failure" : "success";
    }
    results.set(id, result);
    return result;
  };
  for (const id of jobs.keys()) resultOf(id, []);
  return results;
}

/** The jobs of the release workflow that hold a write permission: those that push or publish. */
export function publishingJobs(root: string): string[] {
  return [...jobsOf(root, RELEASE_WORKFLOW)]
    .filter(([, job]) => isMapping(job["permissions"]) && Object.values(job["permissions"]).includes("write"))
    .map(([id]) => id);
}

/** The publishing jobs of the release workflow that would still run if the step at the site failed. */
export function publishingAfterFailure(root: string, failing: Site): string[] {
  const results = run(root, RELEASE_WORKFLOW, failing);
  return publishingJobs(root).filter((id) => results.get(id) !== "skipped");
}

/** What keeps a failing gate from stopping the release, as sentences; none when every gate stops it. */
export function releaseGateProblems(root: string): string[] {
  if (!existsSync(join(root, WORKFLOWS, RELEASE_WORKFLOW))) return [`The repository has no release workflow, ${WORKFLOWS}/${RELEASE_WORKFLOW}.`];
  const problems: string[] = [];
  if (publishingJobs(root).length === 0) problems.push(`No job of ${RELEASE_WORKFLOW} holds a write permission, so nothing publishes the release.`);
  for (const gate of RELEASE_GATES) {
    const sites = gateSites(root, gate);
    if (sites.length === 0) problems.push(`${gate.name} runs in no step of ${RELEASE_WORKFLOW} or of a workflow it calls.`);
    for (const site of sites) {
      const running = publishingAfterFailure(root, site);
      if (running.length > 0) {
        problems.push(
          `When ${gate.name} fails in ${site.file}#${site.job}, step ${site.step + 1}, ` +
            `the release still runs ${running.map((id) => `${RELEASE_WORKFLOW}#${id}`).join(" and ")}, which can push or publish.`,
        );
      }
    }
  }
  return problems;
}
