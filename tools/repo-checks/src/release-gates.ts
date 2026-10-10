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
// skipped; and it counts as passing a script that may go on, or end in
// success, after the gate's command fails, or never run it. GitHub runs a
// script as bash -e when no shell is named, as bash -e with pipefail for
// shell: bash and as sh -e for shell: sh; a step that names no shell takes its
// job's defaults.run.shell, and else its workflow's. So the check counts as
// passing a script in any other shell; one that runs the command anywhere but
// at the start of a line of its own, with ||, &&, ; or & beside it, or piped
// without pipefail; and one whose lines before the command leave it inside a
// block, a condition, a loop, a list, a quoted text or a here-document, or
// turn off -e or pipefail, set a trap, define a function or an alias, or
// exit.
//
// A condition on the gate's job, or on a job it needs, that may not hold when
// the jobs it needs succeeded might skip the gate instead, and a skipped job
// fails neither the workflow that calls it nor the jobs that need it, which
// are skipped in turn unless they run whatever happened: the check also works
// out what runs when such conditions skip the gate. Every job of the release
// workflow that holds a write permission pushes or publishes, so none may run
// after a gate fails or is skipped.

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
  /** Whether the step's script may go on, or end in success, after the gate's command fails. */
  goesOn: boolean;
}

type Result = "success" | "failure" | "skipped";
type Mapping = Record<string, unknown>;

const WORKFLOWS = join(".github", "workflows");
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/;
/** A status function that runs a job, or a step, whatever the jobs it needs did. */
const RUNS_WHATEVER = /\b(?:always|failure|cancelled)\s*\(/;
/** A condition that holds whenever the jobs a job needs succeeded, so it never skips a job that would run without it. */
const HOLDS_ON_SUCCESS = /^(?:\$\{\{\s*)?(?:always\(\)|success\(\)|!\s*cancelled\(\)|true)(?:\s*\}\})?$/;
/** Environment assignments in front of a command. */
const ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*$/;
/** Where a command starts on a line: at its start, or after a separator or an opening parenthesis. */
const AT_COMMAND = "(?:^|[\\s;&|(])";
/** set +e, or set +o errexit, which lets a script go on after a failing command. */
const ERREXIT_OFF = new RegExp(`${AT_COMMAND}set\\s(?:[^;&|]*\\s)?(?:\\+[A-Za-z]*e[A-Za-z]*\\b|\\+o\\s+errexit\\b)`);
/** set -o pipefail, alone or with other options, such as set -euo pipefail. */
const PIPEFAIL_ON = new RegExp(`${AT_COMMAND}set\\s(?:[^;&|]*\\s)?-[A-Za-z]*o\\s+pipefail\\b`);
/** set +o pipefail. */
const PIPEFAIL_OFF = new RegExp(`${AT_COMMAND}set\\s(?:[^;&|]*\\s)?\\+[A-Za-z]*o\\s+pipefail\\b`);
/**
 * Lines that may keep a later failing command from failing the script, or keep it from running: a trap, which can
 * end the script in success whatever made it exit; a function or an alias, which can take a command's place; and an
 * exit, a return or an exec.
 */
const CHANGES_WHAT_RUNS = new RegExp(`${AT_COMMAND}(?:trap|alias|function|exit|return|exec)\\b|[A-Za-z_][\\w:.-]*\\s*\\(\\s*\\)`);
/** Words that open a compound command, and words that close one. */
const OPENS = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const CLOSES = new Set(["fi", "done", "esac", "}"]);
/** An operator at the end of a line, which carries a list or a pipeline on to the next line. */
const CARRIES_ON = /(?:\|\||&&|\|&?)\s*$/;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowOf(root: string, file: string): Mapping {
  const path = join(root, WORKFLOWS, file);
  if (!existsSync(path)) return {};
  const workflow = parse(readFileSync(path, "utf8")) as unknown;
  return isMapping(workflow) ? workflow : {};
}

function jobsOf(root: string, file: string): Map<string, Mapping> {
  const jobs = workflowOf(root, file)["jobs"];
  return new Map(Object.entries(isMapping(jobs) ? jobs : {}).map(([id, job]) => [id, isMapping(job) ? job : {}]));
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

/** Whether a job's condition might skip it when every job it needs succeeded. */
function maySkip(job: Mapping): boolean {
  const condition = job["if"];
  if (condition === undefined || condition === null || condition === true) return false;
  return !(typeof condition === "string" && HOLDS_ON_SUCCESS.test(condition.trim()));
}

/** A line with each quoted text replaced by a placeholder and any comment removed; a quote left over opens a text. */
function plain(line: string): string {
  return line
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "_")
    .replace(/(^|\s)#.*$/, "")
    .trim();
}

/**
 * Whether the step's script may go on, or end in success, after the gate's command fails, or may never run it.
 * GitHub runs a script that names no shell as bash -e, shell: bash as bash -e with pipefail, and shell: sh as sh -e,
 * so a script stops at a failing command that starts a line of its own at the top level, piped into another only
 * under pipefail; another shell, a list or a condition around the command, or lines before it that open a block,
 * turn off -e or pipefail, or change what runs may let the failure through.
 */
function goesOn(script: string, shell: unknown, gate: Gate): boolean {
  if (shell !== undefined && shell !== "bash" && shell !== "sh") return true;
  let pipefail = shell === "bash";
  const lines = script.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const index = lines.findIndex((line) => gate.command.test(line));
  if (index < 0) return true;
  let depth = 0;
  for (const raw of lines.slice(0, index)) {
    const line = plain(raw);
    if (/['"]/.test(line) || /<<(?!<)/.test(line)) return true;
    if (ERREXIT_OFF.test(line) || CHANGES_WHAT_RUNS.test(line)) return true;
    if (PIPEFAIL_ON.test(line) && shell !== "sh") pipefail = true;
    if (PIPEFAIL_OFF.test(line)) pipefail = false;
    const words = line.split(/[\s;&|]+/);
    depth += words.filter((word) => OPENS.has(word)).length - words.filter((word) => CLOSES.has(word)).length;
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (depth < 0) return true;
  }
  if (depth !== 0) return true;
  const previous = lines
    .slice(0, index)
    .map(plain)
    .filter((line) => line.length > 0)
    .at(-1);
  if (previous !== undefined && CARRIES_ON.test(previous)) return true;
  const line = (lines[index] ?? "").replace(/(^|\s)#.*$/, "").trim();
  const match = gate.command.exec(line);
  if (match === null || !ASSIGNMENTS.test(line.slice(0, match.index))) return true;
  // Quoted text and redirections such as 2>&1 hold no operator.
  const rest = line
    .slice(match.index)
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/\d*[<>]&\d*-?|&>>?/g, " ");
  // Under pipefail a pipeline fails with the command; without it, it ends as its last command does.
  return /\|\||&&|[;&]/.test(rest) || (!pipefail && rest.includes("|"));
}

/** The shell GitHub runs a step's script with: the step's own, else its job's default, else its workflow's. */
function shellOf(step: Mapping, job: Mapping, workflow: Mapping): unknown {
  const defaultShell = (holder: Mapping): unknown => {
    const defaults = holder["defaults"];
    const run = isMapping(defaults) ? defaults["run"] : undefined;
    return isMapping(run) ? run["shell"] : undefined;
  };
  return step["shell"] ?? defaultShell(job) ?? defaultShell(workflow);
}

/** The steps that run a gate, in the release workflow and the local workflows it calls. */
export function gateSites(root: string, gate: Gate): Site[] {
  return reachable(root, RELEASE_WORKFLOW).flatMap((file) => {
    const workflow = workflowOf(root, file);
    return [...jobsOf(root, file)].flatMap(([job, definition]) =>
      stepsOf(definition).flatMap((step, index) => {
        const script = step["run"];
        if (typeof script !== "string" || !gate.command.test(script)) return [];
        return [{ file, job, step: index, goesOn: goesOn(script, shellOf(step, definition, workflow), gate) }];
      }),
    );
  });
}

/** The jobs of the site's workflow whose conditions might skip the gate: its job and the jobs it needs, at any depth. */
function skippingJobs(root: string, site: Site): string[] {
  const jobs = jobsOf(root, site.file);
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const job = jobs.get(id);
    if (job !== undefined) needsOf(job).forEach(visit);
  };
  visit(site.job);
  return [...seen].filter((id) => maySkip(jobs.get(id) ?? {}));
}

/**
 * The result of each job of a workflow when the step at the site fails, as GitHub would run it; with skipped, when
 * those jobs of the site's workflow are skipped by their conditions instead of running.
 */
function run(root: string, file: string, failing: Site, skipped: readonly string[] = [], calls: string[] = []): Map<string, Result> {
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
    if (runs && !(failing.file === file && skipped.includes(id))) {
      const called = typeof job["uses"] === "string" ? LOCAL_WORKFLOW.exec(job["uses"])?.[1] : undefined;
      let failed = false;
      if (called !== undefined && !calls.includes(called)) {
        failed = [...run(root, called, failing, skipped, [...calls, file]).values()].includes("failure");
      } else if (failing.file === file && failing.job === id) {
        const step = stepsOf(job)[failing.step] ?? {};
        failed = step["if"] === undefined && !mayContinue(step["continue-on-error"]) && !failing.goesOn;
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

/** The publishing jobs of the release workflow that would still run if conditions skipped the gate at the site. */
export function publishingAfterSkip(root: string, site: Site): string[] {
  const skipped = skippingJobs(root, site);
  if (skipped.length === 0) return [];
  const results = run(root, RELEASE_WORKFLOW, site, skipped);
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
    const jobs = (running: string[]) => running.map((id) => `${RELEASE_WORKFLOW}#${id}`).join(" and ");
    for (const site of sites) {
      const running = publishingAfterFailure(root, site);
      if (running.length > 0) {
        problems.push(`When ${gate.name} fails in ${site.file}#${site.job}, step ${site.step + 1}, the release still runs ${jobs(running)}, which can push or publish.`);
      }
      const unchecked = publishingAfterSkip(root, site);
      if (unchecked.length > 0) {
        problems.push(
          `When a job's condition skips ${gate.name} in ${site.file}#${site.job}, ` +
            `the release still runs ${jobs(unchecked)}, which can push or publish.`,
        );
      }
    }
  }
  return problems;
}
