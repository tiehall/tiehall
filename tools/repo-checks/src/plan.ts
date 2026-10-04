import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// What the coverage checks read from the plan (openspec/changes/<change>):
// the changes in progress, the state of each task of a plan, and the bullets
// of a requirement's list in a spec. A check that mirrors a spec's list, such
// as the confirmation coverage check or the security-event coverage check,
// reads the list through these, so each list it mirrors is read the same way:
// from the change in progress whose spec holds the list, with that change's
// plan, or, once the change is archived, from the main spec under
// openspec/specs, where no task is left to wait for. A later change in
// progress that modifies the requirement governs its wording, so the list is
// read as the newest such change words it, while the tasks stay those of the
// change that added the requirement, which build its actions.

/** The bullets of the list under a requirement's heading, each without its "- ", up to the first blank line after them. */
export function requirementListItems(spec: string, requirement: string): string[] {
  const heading = `### Requirement: ${requirement}`;
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ")) break;
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (items.length > 0 && line.trim() === "") break;
  }
  return items;
}

/** The plan's tasks by number, each done ("- [x]") or not ("- [ ]"). */
export function taskStates(tasks: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const [, mark = "", number = ""] of tasks.matchAll(/^- \[([ x])\] (\d+\.\d+) /gm)) states.set(number, mark === "x");
  return states;
}

/** The folders of the changes in progress under openspec/changes, in name order; the archive is not one. */
export function activeChanges(root: string): string[] {
  const changes = join(root, "openspec", "changes");
  if (!existsSync(changes)) return [];
  return readdirSync(changes, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => join(changes, entry.name))
    .sort();
}

/** A spec that holds a requirement's list, and the plan of the change it belongs to; an archived spec has no plan. */
export interface Plan {
  /** The text of the capability's spec. */
  spec: string;
  /** The text of the change's tasks.md; empty once the change is archived. */
  tasks: string;
}

/**
 * The spec of a capability that holds the requirement's list, and the plan
 * that goes with it: the change in progress whose spec holds the list, with
 * that change's tasks, or, once the change is archived, the main spec under
 * openspec/specs, with no tasks; undefined when no spec holds the list.
 */
export function planFor(root: string, capability: string, requirement: string): Plan | undefined {
  const holds = (file: string): string | undefined => {
    if (!existsSync(file)) return undefined;
    const spec = readFileSync(file, "utf8");
    return requirementListItems(spec, requirement).length > 0 ? spec : undefined;
  };
  const tasksOf = (change: string): string => {
    const plan = join(change, "tasks.md");
    return existsSync(plan) ? readFileSync(plan, "utf8") : "";
  };
  const holding = activeChanges(root).flatMap((change) => {
    const file = join(change, "specs", capability, "spec.md");
    const spec = holds(file);
    return spec === undefined ? [] : [{ change, file, spec, modifies: modifies(spec, requirement) }];
  });
  const adding = holding.find(({ modifies }) => !modifies);
  const age = additionOrder(root);
  const newest = (path: string) => age.get(relative(root, path)) ?? Number.MAX_SAFE_INTEGER;
  const modifying = holding.filter(({ modifies }) => modifies).sort((a, b) => newest(a.file) - newest(b.file));
  if (modifying.length > 1 && isShallow(root)) {
    throw new Error(
      `${modifying.length} changes in progress modify the requirement "${requirement}", and this is a shallow clone, whose history cannot tell which of them is newer; fetch the repository's whole history, as a CI checkout does with fetch-depth: 0.`,
    );
  }
  const wording = modifying.at(-1) ?? adding;
  if (wording !== undefined) return { spec: wording.spec, tasks: tasksOf((adding ?? wording).change) };
  const spec = holds(join(root, "openspec", "specs", capability, "spec.md"));
  return spec === undefined ? undefined : { spec, tasks: "" };
}

/** Whether the spec holds the requirement under its "## MODIFIED Requirements" heading. */
function modifies(spec: string, requirement: string): boolean {
  const lines = spec.split("\n");
  const at = lines.findIndex((line) => line.trim() === `### Requirement: ${requirement}`);
  const section = lines.slice(0, at).findLast((line) => line.startsWith("## "));
  return section?.trim() === "## MODIFIED Requirements";
}

/** Whether the repository is a shallow clone, such as a CI job's checkout at depth 1, which holds only the latest commits. */
function isShallow(root: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The order in which commits added the files under openspec/changes, oldest
 * first, by their paths from the root. A change no commit has added yet is
 * newer than every committed one, and outside a git repository every change
 * is; changes alike in age keep their name order.
 */
function additionOrder(root: string): Map<string, number> {
  let added: string;
  try {
    added = execFileSync("git", ["log", "--reverse", "--diff-filter=A", "--name-only", "--relative", "--format=", "--", "openspec/changes"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Map();
  }
  const order = new Map<string, number>();
  for (const path of added.split("\n")) if (path !== "" && !order.has(path)) order.set(path, order.size);
  return order;
}
