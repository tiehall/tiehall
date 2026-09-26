import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What the coverage checks read from the plan (openspec/changes/<change>):
// the changes in progress, the state of each task of a plan, and the bullets
// of a requirement's list in a spec. A check that mirrors a spec's list, such
// as the confirmation coverage check or the security-event coverage check,
// reads the list through these, so each list it mirrors is read the same way:
// from the change in progress whose spec holds the list, with that change's
// plan, or, once the change is archived, from the main spec under
// openspec/specs, where no task is left to wait for.

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
  for (const change of activeChanges(root)) {
    const spec = holds(join(change, "specs", capability, "spec.md"));
    if (spec === undefined) continue;
    const plan = join(change, "tasks.md");
    return { spec, tasks: existsSync(plan) ? readFileSync(plan, "utf8") : "" };
  }
  const spec = holds(join(root, "openspec", "specs", capability, "spec.md"));
  return spec === undefined ? undefined : { spec, tasks: "" };
}
