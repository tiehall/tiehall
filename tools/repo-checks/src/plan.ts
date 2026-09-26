import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// What the coverage checks read from the plan (openspec/changes/<change>):
// the active change's folder, the state of each of its tasks, and the bullets
// of a requirement's list in one of its specs. A check that mirrors a spec's
// list, such as the confirmation coverage check or the security-event coverage
// check, reads the list through these, so each list it mirrors is read the
// same way.

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

/**
 * The active change's folder under openspec/changes, which holds the plan and
 * the specs a list mirrors while the change is in progress; undefined once it
 * is archived.
 */
export function activeChange(root: string): string | undefined {
  const changes = join(root, "openspec", "changes");
  if (!existsSync(changes)) return undefined;
  const folders = readdirSync(changes, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive" && existsSync(join(changes, entry.name, "tasks.md")))
    .map((entry) => join(changes, entry.name));
  return folders.length === 1 ? folders[0] : undefined;
}
