import { execFileSync } from "node:child_process";
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

  it("is the list as the newest change that modifies the requirement words it, with the tasks of the change that added it", () => {
    const modified = (item: string) => `# Spec Delta: activity-log

## MODIFIED Requirements

### Requirement: Which actions are security events

Tiehall SHALL record a security event for each of these:
- a role change;
- ${item};
- an export of the activity log.
`;
    const scratch = mkdtempSync(join(tmpdir(), "tiehall-plan-modified-"));
    const write = (name: string, path: string, text: string) => {
      const file = join(scratch, "openspec", "changes", name, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    };
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: scratch });
      git("init", "--quiet", "--initial-branch=main");
      write("zz-add-v1", "tasks.md", "- [ ] 9.8 Remove a member.\n- [x] 20.6 Export.\n");
      write("zz-add-v1", "specs/activity-log/spec.md", `# activity-log\n\n## ADDED Requirements\n\n${SPEC}`);
      git("add", ".");
      git("commit", "--quiet", "-m", "The plan");
      // A follow-up committed later, whose name sorts first, and one not yet committed, which is the newest.
      write("a-follow-up", "tasks.md", "- [ ] 1.1 Its own task.\n");
      write("a-follow-up", "specs/activity-log/spec.md", modified("a revoked invite"));
      git("add", ".");
      git("commit", "--quiet", "-m", "A follow-up");
      expect(planFor(scratch, "activity-log", "Which actions are security events")).toEqual({
        spec: modified("a revoked invite"),
        tasks: "- [ ] 9.8 Remove a member.\n- [x] 20.6 Export.\n",
      });
      write("b-in-progress", "specs/activity-log/spec.md", modified("a sign-in"));
      expect(planFor(scratch, "activity-log", "Which actions are security events")?.spec).toBe(modified("a sign-in"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // A shallow clone, such as a CI job's checkout at depth 1, holds one commit, which seems to add every change at once,
  // so it cannot tell which of two changes that modify the requirement is the newer one: the check says so, rather than
  // reading the list as the change whose name sorts last words it.
  it("is refused in a shallow clone that cannot tell which of two modifying changes is newer", () => {
    const modified = (item: string) => `# Spec Delta: activity-log\n\n## MODIFIED Requirements\n\n${SPEC.replace("- a role change;", `- a role change;\n- ${item};`)}`;
    const scratch = mkdtempSync(join(tmpdir(), "tiehall-plan-shallow-"));
    const origin = join(scratch, "origin");
    const write = (name: string, path: string, text: string) => {
      const file = join(origin, "openspec", "changes", name, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    };
    try {
      mkdirSync(origin);
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd });
      git(origin, "init", "--quiet", "--initial-branch=main");
      write("add-v1", "specs/activity-log/spec.md", `# activity-log\n\n## ADDED Requirements\n\n${SPEC}`);
      write("zz-first-follow-up", "specs/activity-log/spec.md", modified("a revoked invite"));
      git(origin, "add", ".");
      git(origin, "commit", "--quiet", "-m", "The plan and a follow-up");
      write("a-second-follow-up", "specs/activity-log/spec.md", modified("a sign-in"));
      git(origin, "add", ".");
      git(origin, "commit", "--quiet", "-m", "A second follow-up");
      expect(planFor(origin, "activity-log", "Which actions are security events")?.spec).toBe(modified("a sign-in"));

      git(scratch, "clone", "--quiet", "--depth", "1", `file://${origin}`, "shallow");
      expect(() => planFor(join(scratch, "shallow"), "activity-log", "Which actions are security events")).toThrow(/shallow.*fetch-depth: 0/s);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
