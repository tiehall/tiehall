import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeChanges, planFor, requirementListItems, taskStates } from "../src/plan.ts";

// What the coverage checks read from the plan: a list that mirrors a spec's
// requirement is read from the change in progress whose spec holds it, with
// that change's tasks, so a second change in progress, on another capability
// or on a requirement without the list, never blinds a check; once the change
// is archived, the main spec under openspec/specs is read, with no tasks left
// to wait for.

const SPEC = `### Requirement: Which actions are security events

Tiehall SHALL record a security event for each of these:
- a role change;
- an export of the activity log.

### Requirement: Another requirement
- not an item of the list
`;

let root: string;

/** A change folder with these files, each by its path under the folder. */
function change(name: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, "openspec", "changes", name, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tiehall-plan-"));
  // An archived change, which counts as none; a change on another capability; and the change that holds the list.
  change("archive/2026-01-01-old", { "tasks.md": "- [x] 1.1 Old.\n" });
  change("add-image-flag", { "tasks.md": "- [x] 9.8 The same number, done in another plan.\n", "specs/self-host-install/spec.md": "### Requirement: Other\n- an item\n" });
  change("add-v1", { "tasks.md": "- [ ] 9.8 Remove a member.\n- [x] 20.6 Export.\n", "specs/activity-log/spec.md": SPEC });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the changes in progress", () => {
  it("are the folders under openspec/changes but the archive, in name order", () => {
    expect(activeChanges(root).map((folder) => folder.slice(root.length))).toEqual(["/openspec/changes/add-image-flag", "/openspec/changes/add-v1"]);
    expect(activeChanges(join(root, "nowhere"))).toEqual([]);
  });
});

describe("the plan a list mirrors", () => {
  it("is the change in progress whose spec holds the requirement's list, with that change's tasks", () => {
    const plan = planFor(root, "activity-log", "Which actions are security events");
    expect(plan?.spec).toBe(SPEC);
    expect(requirementListItems(plan?.spec ?? "", "Which actions are security events")).toEqual(["a role change;", "an export of the activity log."]);
    expect(taskStates(plan?.tasks ?? "")).toEqual(
      new Map([
        ["9.8", false],
        ["20.6", true],
      ]),
    );
  });

  it("is the main spec, with no tasks, once the change is archived, and nothing when no spec holds the list", () => {
    expect(planFor(root, "activity-log", "Another requirement without a list")).toBeUndefined();
    expect(planFor(root, "agent-safety", "Which actions are security events")).toBeUndefined();
    mkdirSync(join(root, "openspec", "specs", "agent-safety"), { recursive: true });
    writeFileSync(join(root, "openspec", "specs", "agent-safety", "spec.md"), "### Requirement: Actions that need the confirmation step\n- exporting the activity log.\n");
    expect(planFor(root, "agent-safety", "Actions that need the confirmation step")).toEqual({
      spec: "### Requirement: Actions that need the confirmation step\n- exporting the activity log.\n",
      tasks: "",
    });
  });
});
