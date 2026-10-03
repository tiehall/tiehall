import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskStates } from "./plan.ts";
import { readSources } from "./source-citations.ts";

// The security review checklist and its records (self-host-install: The
// setup code guards the setup screen; agent-safety: The confirmation step
// runs only in the web UI; activity-log: The activity log is append-only;
// design.md, Decisions this change rests on: D38). The checklist,
// docs/security/review-checklist.md, lists items as `### SR-<n> <title>`,
// each with lines that name what it checks:
// - `- Requirement: <capability>: <Requirement name>`, one or more;
// - `- Check: <what a reviewer reads and tries>`;
// - `- Test: \`<file>\`: "<the test's title, or the start of it>"`;
// - `- Gap: <why no test holds a property yet, and which task will>`.
// A review is recorded in docs/security/reviews/<YYYY-MM-DD>.md, with a table
// of results, one row per item: `| SR-<n> | <result> | <notes> |`, the
// result Pass, Gap, or the findings it raised, such as F1 or F1, F2; each
// finding is described under `### F<n> <title>`, with a line
// `- Task: <task>` for each task of the plan that fixes it, such as 26.15,
// which its triage added with a failing test first.

export const CHECKLIST_PATH = "docs/security/review-checklist.md";
export const REVIEWS_PATH = "docs/security/reviews";
/** The plan whose tasks fix the findings. */
export const PLAN_PATH = "openspec/changes/add-tiehall-oss-v1/tasks.md";

export interface ChecklistItem {
  id: string;
  title: string;
  requirements: { capability: string; name: string }[];
  checks: string[];
  tests: { file: string; title: string }[];
  gaps: string[];
}

export interface ReviewResult {
  id: string;
  result: string;
  notes: string;
}

export interface ReviewFinding {
  id: string;
  title: string;
  /** The tasks of the plan that fix it. */
  tasks: string[];
}

export interface Review {
  results: ReviewResult[];
  findings: ReviewFinding[];
}

const ITEM = /^### (SR-\d+) (.+)$/;
const REQUIREMENT = /^- Requirement: ([a-z][a-z-]*): (.+)$/;
const CHECK = /^- Check: (.+)$/;
const TEST = /^- Test: `([^`]+)`: "(.+)"$/;
const GAP = /^- Gap: (.+)$/;
const RESULT = /^\| (SR-\d+) \| ([^|]+) \| (.*) \|$/;
const RESULTS = /^(Pass|Gap|F\d+(, F\d+)*)$/;
const FINDING = /^### (F\d+) (.+)$/;
const TASK = /^- Task: (\d+\.\d+)$/;
const ANY_HEADING = /^#{1,3} /;

/** The checklist's items, in order. */
export function parseChecklist(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of text.split("\n")) {
    const heading = ITEM.exec(line);
    if (heading !== null) {
      items.push({ id: heading[1] ?? "", title: heading[2] ?? "", requirements: [], checks: [], tests: [], gaps: [] });
      continue;
    }
    const item = items.at(-1);
    if (item === undefined) continue;
    const requirement = REQUIREMENT.exec(line);
    if (requirement !== null) item.requirements.push({ capability: requirement[1] ?? "", name: requirement[2] ?? "" });
    const check = CHECK.exec(line);
    if (check !== null) item.checks.push(check[1] ?? "");
    const test = TEST.exec(line);
    if (test !== null) item.tests.push({ file: test[1] ?? "", title: test[2] ?? "" });
    const gap = GAP.exec(line);
    if (gap !== null) item.gaps.push(gap[1] ?? "");
  }
  return items;
}

/** A review record's results and findings, in order. */
export function parseReview(text: string): Review {
  const results: ReviewResult[] = [];
  const findings: ReviewFinding[] = [];
  let finding: ReviewFinding | undefined;
  for (const line of text.split("\n")) {
    const row = RESULT.exec(line.trim());
    if (row !== null) results.push({ id: row[1] ?? "", result: (row[2] ?? "").trim(), notes: (row[3] ?? "").trim() });
    const heading = FINDING.exec(line);
    if (heading !== null) {
      finding = { id: heading[1] ?? "", title: heading[2] ?? "", tasks: [] };
      findings.push(finding);
      continue;
    }
    if (ANY_HEADING.test(line)) finding = undefined;
    const task = TASK.exec(line);
    if (task !== null && finding !== undefined) finding.tasks.push(task[1] ?? "");
  }
  return { results, findings };
}

/** The latest review record among these file names: the one named by the latest date. */
export function latestReview(names: readonly string[]): string | undefined {
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().at(-1);
}

export interface ReviewInputs {
  checklist: string;
  record: string;
  requirementExists(capability: string, name: string): boolean;
  testExists(file: string, title: string): boolean;
  /** Whether the plan has a task with this number, such as 26.15. */
  taskExists(task: string): boolean;
}

/** What is wrong with the checklist and the latest record, each as a sentence; none when both hold. */
export function reviewProblems({ checklist, record, requirementExists, testExists, taskExists }: ReviewInputs): string[] {
  const problems: string[] = [];
  const items = parseChecklist(checklist);
  const { results, findings } = parseReview(record);
  for (const item of items) {
    if (item.requirements.length === 0) problems.push(`${item.id} names no requirement.`);
    if (item.tests.length === 0 && item.gaps.length === 0) problems.push(`${item.id} names neither a test nor a gap.`);
    for (const { capability, name } of item.requirements) {
      if (!requirementExists(capability, name)) problems.push(`${item.id} names ${capability}: ${name}, which is no requirement of the specs.`);
    }
    for (const { file, title } of item.tests) {
      if (!testExists(file, title)) problems.push(`${item.id} names the test "${title}" in ${file}, which that file does not hold.`);
    }
  }
  for (const item of items) {
    const result = results.find(({ id }) => id === item.id);
    if (result === undefined) problems.push(`${item.id} has no result in the latest review record.`);
    else if (!RESULTS.test(result.result)) problems.push(`${item.id}'s result "${result.result}" is not Pass, Gap or a finding such as F1.`);
  }
  for (const { id } of results) {
    if (!items.some((item) => item.id === id)) problems.push(`The latest review record has a result for ${id}, which the checklist does not have.`);
  }
  for (const { id, result } of results) {
    for (const named of result.match(/F\d+/g) ?? []) {
      if (!findings.some((finding) => finding.id === named)) problems.push(`${named}, which ${id}'s result names, is not described in the latest review record.`);
    }
  }
  for (const finding of findings) {
    if (finding.tasks.length === 0) problems.push(`${finding.id} names no task that fixes it.`);
    for (const task of finding.tasks) if (!taskExists(task)) problems.push(`${finding.id} names task ${task}, which the plan does not have.`);
  }
  return problems;
}

/** The problems of the real tree's checklist and its latest record. */
export function securityReviewProblems(root: string): string[] {
  const checklistFile = join(root, CHECKLIST_PATH);
  if (!existsSync(checklistFile)) return [`${CHECKLIST_PATH} does not exist.`];
  const folder = join(root, REVIEWS_PATH);
  const latest = existsSync(folder) ? latestReview(readdirSync(folder)) : undefined;
  if (latest === undefined) return [`${REVIEWS_PATH} holds no review record.`];
  const { requirements } = readSources(root);
  const tasks = taskStates(readFileSync(join(root, PLAN_PATH), "utf8"));
  return reviewProblems({
    checklist: readFileSync(checklistFile, "utf8"),
    record: readFileSync(join(folder, latest), "utf8"),
    requirementExists: (capability, name) => requirements.get(capability)?.includes(name) === true,
    testExists: (file, title) => {
      const path = join(root, file);
      return /\.test\.ts$/.test(file) && existsSync(path) && readFileSync(path, "utf8").includes(title);
    },
    taskExists: (task) => tasks.has(task),
  });
}
