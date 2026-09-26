import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineEventType, EVENT_TYPES, type EventType } from "@tiehall/core";
import { requirementListItems, taskStates } from "../src/plan.ts";
import {
  builtActions,
  readSecurityEventInputs,
  securityEventCoverageProblems,
  specItems,
  type SecurityEventInputs,
  type SecurityEventList,
} from "../src/security-event-coverage.ts";

// The security-event coverage check (activity-log: Which actions are security
// events). A committed list mirrors the spec's list of the actions Tiehall
// records a security event for. Each action names the task that builds it
// until that task does, and then the type of its security event and the test
// that shows the action appending that event together with its change; CI
// fails when a listed action that is built names no event or no such test,
// when its test does not exist or does not run, when a task is done but its
// action is still pending, and when a security event type is defined that no
// action of the list names.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-security-events.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/security-events/${name}/`, import.meta.url));

const SPEC = `### Requirement: Which actions are security events

Tiehall SHALL record a security event for each of these:
- a role change, and a member's removal;
- an export of the activity log.

For a change that Tiehall's own commands make, the change and its security event SHALL be recorded together or not at all.

### Requirement: Writes the sign-in service owns are still recorded
- not an item of the list
`;

const TASKS = `## 9. Teams
- [x] 9.7 Change a member's role with the confirmation step.
- [ ] 9.8 Remove a member with the confirmation step.
- [ ] 20.6 Export the activity log with the confirmation step.
`;

const roleChanged = defineEventType({
  type: "member.role_changed",
  class: "security",
  fields: { userId: { kind: "id", of: "user" }, role: { kind: "enum", values: ["admin", "member"] } },
});
const removed = defineEventType({
  type: "member.removed",
  class: "security",
  fields: { userId: { kind: "id", of: "user" } },
});
const claimed = defineEventType({
  type: "request.claimed",
  class: "domain",
  fields: { requestId: { kind: "id", of: "request" }, userId: { kind: "id", of: "user" } },
});

/** The event types once 9.7 has built the role change: its security event, and a domain event. */
const eventTypes: EventType[] = [roleChanged, claimed];
/** The event types once 9.8 has built the removal too. */
const withRemoval: EventType[] = [roleChanged, removed, claimed];

const ROLE_TEST = "packages/commands/test/member-roles.test.ts";
const ROLE_CASE = "makes the member an admin, and the activity log gains a security event naming the admin, the member and the new role";

/** The test files of a repository where 9.7 has written the role change's test. */
const files: Record<string, string> = {
  [ROLE_TEST]: `describe("a confirmed role change", () => {
  it("${ROLE_CASE}", async () => {
    expect(events("member.role_changed")).toHaveLength(1);
  });
  it.skip("is skipped for now", async () => {});
});
`,
  "packages/commands/test/member-removal.test.ts": `describe("a confirmed removal", () => {
  it.fails("records a security event naming the admin", async () => {});
});
`,
  "packages/commands/test/notes.test.ts": `it("mentions no event type at all", () => {});\n`,
};

/** The list as it stands once 9.7 has built the role change, and 9.8 and 20.6 are still to come. */
function list(): SecurityEventList {
  return {
    items: [
      {
        item: "a role change, and a member's removal;",
        actions: [
          { action: "a role change", event: "member.role_changed", test: { file: ROLE_TEST, case: ROLE_CASE } },
          { action: "a member's removal", pending: "9.8" },
        ],
      },
      { item: "an export of the activity log.", actions: [{ action: "an export of the activity log", pending: "20.6" }] },
    ],
  };
}

/** The inputs of the check, with the parts a case changes. */
function inputs(change: Partial<SecurityEventInputs> = {}): SecurityEventInputs {
  return {
    list: list(),
    specItems: specItems(SPEC),
    tasks: taskStates(TASKS),
    eventTypes,
    readFile: (path) => files[path],
    ...change,
  };
}

/** The list with its first item's actions replaced. */
function withActions(actions: Record<string, unknown>[]): unknown {
  const changed = list() as { items: { item: string; actions: unknown[] }[] };
  changed.items[0] = { item: changed.items[0]?.item ?? "", actions };
  return changed;
}

const secondAction = () => list().items[0]!.actions[1]!;

describe("the spec's list", () => {
  it("is read as the bullets of the requirement, and nothing of the next one", () => {
    expect(specItems(SPEC)).toEqual(["a role change, and a member's removal;", "an export of the activity log."]);
    expect(requirementListItems(SPEC, "Which actions are security events")).toEqual(specItems(SPEC));
    expect(requirementListItems(SPEC, "A requirement the spec does not hold")).toEqual([]);
  });

  it("gives each task's state from the plan", () => {
    expect(taskStates(TASKS)).toEqual(
      new Map([
        ["9.7", true],
        ["9.8", false],
        ["20.6", false],
      ]),
    );
  });
});

describe("the security-event coverage check", () => {
  it("passes a list that mirrors the spec, with built actions' events and tests and unbuilt actions' tasks", () => {
    expect(securityEventCoverageProblems(inputs())).toEqual([]);
    expect(builtActions(list())).toEqual([{ action: "a role change", event: "member.role_changed", test: { file: ROLE_TEST, case: ROLE_CASE } }]);
  });

  it("fails an action that names neither its event nor the task that builds it", () => {
    expect(securityEventCoverageProblems(inputs({ list: withActions([{ action: "a role change" }, secondAction()]) }))).toEqual([
      'a role change: it names neither its security event, with the test that shows it appended, nor the task that builds it, as "pending": "<task>".',
      "member.role_changed is a security event, but no action of the list names it.",
    ]);
  });

  it("fails an action still pending on a task that is done, or on a task the plan does not hold", () => {
    expect(securityEventCoverageProblems(inputs({ list: withActions([{ action: "a role change", pending: "9.7" }, secondAction()]) }))).toEqual([
      "a role change: task 9.7 is done, so this action names its security event and the test that shows it appended.",
      "member.role_changed is a security event, but no action of the list names it.",
    ]);
    expect(securityEventCoverageProblems(inputs({ list: withActions([{ action: "a role change", pending: "99.1" }, secondAction()]) }))).toEqual([
      "a role change: the plan has no task 99.1.",
      "member.role_changed is a security event, but no action of the list names it.",
    ]);
  });

  it("fails an action whose event Tiehall does not define, or is a domain event", () => {
    const problems = securityEventCoverageProblems(
      inputs({
        list: withActions([
          { action: "a role change", event: "member.role_set", test: { file: ROLE_TEST, case: ROLE_CASE } },
          { action: "a member's removal", event: "request.claimed", test: { file: ROLE_TEST, case: ROLE_CASE } },
        ]),
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "a role change: Tiehall defines no event type member.role_set.",
        "a member's removal: request.claimed is a domain event, not a security event.",
        "member.role_changed is a security event, but no action of the list names it.",
      ]),
    );
  });

  it("fails a built action without a test that it appends its event together with its change", () => {
    const withEvent = (test: unknown) => withActions([{ action: "a role change", event: "member.role_changed", ...(test === undefined ? {} : { test }) }, secondAction()]);
    expect(securityEventCoverageProblems(inputs({ list: withEvent(undefined) }))).toEqual([
      'a role change: it names its event member.role_changed but no test that it appends that event together with its change, as "test": { "file", "case" }.',
    ]);
    expect(securityEventCoverageProblems(inputs({ list: withEvent({ file: "packages/commands/test/missing.test.ts", case: ROLE_CASE }) }))).toEqual([
      "a role change: its test file packages/commands/test/missing.test.ts is not a test file of the repository.",
    ]);
    expect(securityEventCoverageProblems(inputs({ list: withEvent({ file: "packages/commands/src/member-changes.ts", case: ROLE_CASE }) }))).toEqual([
      "a role change: its test file packages/commands/src/member-changes.ts is not a test file of the repository.",
    ]);
    expect(securityEventCoverageProblems(inputs({ list: withEvent({ file: ROLE_TEST, case: "records the role change" }) }))).toEqual([
      `a role change: ${ROLE_TEST} holds no test titled "records the role change" that runs.`,
    ]);
    // A skipped test, or one expected to fail, does not show the event being appended.
    expect(securityEventCoverageProblems(inputs({ list: withEvent({ file: ROLE_TEST, case: "is skipped for now" }) }))).toEqual([
      `a role change: ${ROLE_TEST} holds no test titled "is skipped for now" that runs.`,
    ]);
    expect(
      securityEventCoverageProblems(
        inputs({
          eventTypes: withRemoval,
          list: withActions([
            list().items[0]!.actions[0]!,
            {
              action: "a member's removal",
              event: "member.removed",
              test: { file: "packages/commands/test/member-removal.test.ts", case: "records a security event naming the admin" },
            },
          ]),
        }),
      ),
    ).toEqual(['a member\'s removal: packages/commands/test/member-removal.test.ts holds no test titled "records a security event naming the admin" that runs.']);
    expect(securityEventCoverageProblems(inputs({ list: withEvent({ file: "packages/commands/test/notes.test.ts", case: "mentions no event type at all" }) }))).toEqual([
      "a role change: packages/commands/test/notes.test.ts never names the event type member.role_changed, so its test does not show the event being appended.",
    ]);
  });

  it("fails a security event type that is defined but named by no action", () => {
    // 9.8 built the removal's event, and the list still waits for 9.8.
    expect(securityEventCoverageProblems(inputs({ eventTypes: withRemoval }))).toEqual([
      "member.removed is a security event, but no action of the list names it.",
    ]);
  });

  it("fails a list that does not mirror the spec's items", () => {
    const missing = { items: [list().items[0]!] };
    expect(securityEventCoverageProblems(inputs({ list: missing }))).toEqual([
      'The list does not mirror activity-log: Which actions are security events: the spec has "an export of the activity log." where the list has nothing.',
    ]);
    const reworded = { items: [list().items[0]!, { item: "an export of the log.", actions: [{ action: "an export of the log", pending: "20.6" }] }] };
    expect(securityEventCoverageProblems(inputs({ list: reworded }))).toEqual([
      'The list does not mirror activity-log: Which actions are security events: the spec has "an export of the activity log." where the list has "an export of the log.".',
    ]);
  });

  it("fails a list that is not a list of items with actions", () => {
    expect(securityEventCoverageProblems(inputs({ list: { items: "none" } }))).toEqual([
      "The list is not { items: [{ item, actions: [{ action, event and test, or pending }] }] }.",
    ]);
  });
});

describe("the check's script", () => {
  function check(root: string) {
    const run = spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: 120_000 });
    if (run.error) throw run.error;
    return run;
  }

  it("fails a fixture tree whose list has a built action without a test", () => {
    const run = check(fixture("entry-without-test"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'a role change: it names its event member.role_changed but no test that it appends that event together with its change, as "test": { "file", "case" }.',
    );
  });

  it("passes the real tree, whose list mirrors the spec and names the test of every built action and the task of every other", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^tools\/repo-checks\/security-events\.json mirrors the \d+ items of activity-log: Which actions are security events/);
    expect(securityEventCoverageProblems(readSecurityEventInputs(repoRoot, EVENT_TYPES))).toEqual([]);
  });

  it("names, for every security event type Tiehall defines, the test that shows it appended", () => {
    const committed = JSON.parse(readFileSync(new URL("../security-events.json", import.meta.url), "utf8")) as SecurityEventList;
    expect(committed.items.length).toBe(readSecurityEventInputs(repoRoot, EVENT_TYPES).specItems.length);
    const named = new Set(builtActions(committed).map(({ event }) => event));
    for (const { type } of EVENT_TYPES.filter(({ class: cls }) => cls === "security")) expect(named, type).toContain(type);
  });
});
