import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventType } from "@tiehall/core";
import { activeChange, requirementListItems, taskStates } from "./plan.ts";

// The security-event coverage check (activity-log: Which actions are security
// events; design.md, Self-hosting decisions: S14). A committed list,
// tools/repo-checks/security-events.json, mirrors the spec's list of the
// actions Tiehall records a security event for: one item per bullet of the
// requirement, in the spec's order, each with the actions it names. An action
// names the task of the plan that builds it until that task does; from then on
// it names the type of its security event and the test that shows the action
// appending that event together with its change: a test file of the
// repository and the exact title of a test in it, which names the event's
// type. The check fails:
// - when the list's items are not the spec's bullets, in order;
// - when an action names neither its event and test nor a task, a task the
//   plan does not hold, or a task that is done while the action still waits
//   for it;
// - when an action's event is not a security event type Tiehall defines;
// - when an action names its event but no test, a test file that does not
//   exist, a title that no test of that file carries (a skipped, expected-to-
//   fail or to-do test does not count), or a file that never names the event's
//   type;
// - when a security event type Tiehall defines is named by no action, so no
//   security event is added without a listed, tested action.
// `pnpm test` runs the named tests; this check makes sure they exist.

/** Where the list lives, relative to the repository's root. */
export const SECURITY_EVENT_LIST = "tools/repo-checks/security-events.json";
/** The requirement the list mirrors. */
export const REQUIREMENT = "activity-log: Which actions are security events";
const REQUIREMENT_NAME = "Which actions are security events";

/** The test that shows an action appending its security event together with its change. */
export interface SecurityEventTest {
  /** The test file, relative to the repository's root. */
  file: string;
  /** The exact title of the test in that file. */
  case: string;
}

/** An action of the list: built, with its event and its test, or pending on the task that builds it. */
export type SecurityEventAction =
  | { action: string; event: string; test?: SecurityEventTest; pending?: undefined }
  | { action: string; pending: string; event?: undefined; test?: undefined };

export interface SecurityEventList {
  items: { item: string; actions: SecurityEventAction[] }[];
}

export interface SecurityEventInputs {
  /** The committed list, as JSON parsed it. */
  list: unknown;
  /** The bullets of the spec's requirement, in order. */
  specItems: readonly string[];
  /** Each task of the plan, by its number, and whether it is done. */
  tasks: ReadonlyMap<string, boolean>;
  /** The event types Tiehall defines. */
  eventTypes: readonly EventType[];
  /** The text of a file of the repository, by its path from the root; undefined when there is none. */
  readFile(path: string): string | undefined;
}

/** The bullets of the requirement's list. */
export function specItems(spec: string): string[] {
  return requirementListItems(spec, REQUIREMENT_NAME);
}

/** The list's built actions: those that name their security event. */
export function builtActions(list: SecurityEventList): { action: string; event: string; test?: SecurityEventTest }[] {
  return list.items.flatMap(({ actions }) =>
    actions.flatMap((entry) => (entry.event === undefined ? [] : [{ action: entry.action, event: entry.event, ...(entry.test === undefined ? {} : { test: entry.test }) }])),
  );
}

function isList(value: unknown): value is SecurityEventList {
  if (typeof value !== "object" || value === null || !Array.isArray((value as SecurityEventList).items)) return false;
  return (value as SecurityEventList).items.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof item.item === "string" &&
      Array.isArray(item.actions) &&
      item.actions.every((entry) => typeof entry === "object" && entry !== null && typeof entry.action === "string"),
  );
}

/** Whether a test file holds a test, not skipped, expected to fail or to do, with exactly this title. */
function hasTest(text: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:it|test)\\(\\s*(["'\`])${escaped}\\1`).test(text);
}

/** Every way the list breaks the rules above, as a sentence; none when it keeps them. */
export function securityEventCoverageProblems(inputs: SecurityEventInputs): string[] {
  const { list } = inputs;
  if (!isList(list)) return ["The list is not { items: [{ item, actions: [{ action, event and test, or pending }] }] }."];
  const problems: string[] = [];

  const listed = list.items.map(({ item }) => item);
  for (let index = 0; index < Math.max(listed.length, inputs.specItems.length); index += 1) {
    const inSpec = inputs.specItems[index];
    const inList = listed[index];
    if (inSpec === inList) continue;
    problems.push(
      `The list does not mirror ${REQUIREMENT}: the spec has ${inSpec === undefined ? "nothing" : `"${inSpec}"`} ` +
        `where the list has ${inList === undefined ? "nothing" : `"${inList}"`}.`,
    );
  }

  const securityTypes = new Map(inputs.eventTypes.filter((type) => type.class === "security").map((type) => [type.type, type]));
  const named = new Set<string>();
  for (const entry of list.items.flatMap(({ actions }) => actions)) {
    const problem = (text: string) => problems.push(`${entry.action}: ${text}`);
    if (typeof entry.event === "string") {
      named.add(entry.event);
      if (!securityTypes.has(entry.event)) {
        const other = inputs.eventTypes.find(({ type }) => type === entry.event);
        problem(other === undefined ? `Tiehall defines no event type ${entry.event}.` : `${entry.event} is a ${other.class} event, not a security event.`);
      }
      const test = entry.test;
      if (typeof test !== "object" || test === null || typeof test.file !== "string" || typeof test.case !== "string") {
        problem(`it names its event ${entry.event} but no test that it appends that event together with its change, as "test": { "file", "case" }.`);
        continue;
      }
      const text = test.file.endsWith(".test.ts") ? inputs.readFile(test.file) : undefined;
      if (text === undefined) {
        problem(`its test file ${test.file} is not a test file of the repository.`);
      } else if (!hasTest(text, test.case)) {
        problem(`${test.file} holds no test titled "${test.case}" that runs.`);
      } else if (!text.includes(entry.event)) {
        problem(`${test.file} never names the event type ${entry.event}, so its test does not show the event being appended.`);
      }
    } else if (typeof entry.pending === "string") {
      const done = inputs.tasks.get(entry.pending);
      if (done === undefined) problem(`the plan has no task ${entry.pending}.`);
      else if (done) problem(`task ${entry.pending} is done, so this action names its security event and the test that shows it appended.`);
    } else {
      problem('it names neither its security event, with the test that shows it appended, nor the task that builds it, as "pending": "<task>".');
    }
  }

  for (const type of securityTypes.keys()) {
    if (!named.has(type)) problems.push(`${type} is a security event, but no action of the list names it.`);
  }
  return problems;
}

/** Reads the check's inputs from a repository's root, with the event types the checked code defines. */
export function readSecurityEventInputs(root: string, eventTypes: readonly EventType[]): SecurityEventInputs {
  const change = activeChange(root);
  const specs = [
    ...(change === undefined ? [] : [join(change, "specs", "activity-log", "spec.md")]),
    join(root, "openspec", "specs", "activity-log", "spec.md"),
  ];
  const spec = specs.find((file) => existsSync(file) && specItems(readFileSync(file, "utf8")).length > 0);
  const tasks = change === undefined ? "" : readFileSync(join(change, "tasks.md"), "utf8");
  return {
    list: JSON.parse(readFileSync(join(root, SECURITY_EVENT_LIST), "utf8")),
    specItems: spec === undefined ? [] : specItems(readFileSync(spec, "utf8")),
    tasks: taskStates(tasks),
    eventTypes,
    readFile: (path) => {
      const file = join(root, path);
      return !path.startsWith("/") && !path.split("/").includes("..") && existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
  };
}
