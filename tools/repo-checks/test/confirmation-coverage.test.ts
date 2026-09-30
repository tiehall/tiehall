import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, defineCatalog, defineCommand, type Catalog } from "@tiehall/catalog";
import {
  confirmationCoverageProblems,
  readCoverageInputs,
  specItems,
  taskStates,
  type CoverageInputs,
} from "../src/confirmation-coverage.ts";

// The confirmation coverage check (agent-safety: Actions that need the
// confirmation step; agent-safety: The confirmation step runs only in the web
// UI; agent-surfaces: Admin actions and trust changes are on no agent
// surface). A committed list mirrors the spec's list of actions that need the
// confirmation step. Each action names the task that builds it until that task
// does, and then its confirm command with an input for its two cases; CI fails
// when a listed action that is built has no such command, when its two cases
// cannot run, when a task is done but its action is still pending, and when a
// confirm command appears in the OpenAPI document, the tool list or the CLI.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-confirmations.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/confirmations/${name}/`, import.meta.url));

const SPEC = `### Requirement: Actions that need the confirmation step

Each of these actions SHALL take effect only after the person taking it has confirmed it:
- changing a member's role, and removing a member;
- exporting the activity log.

A request for one of these actions without a valid confirmation SHALL be refused.

### Requirement: The confirmation step runs only in the web UI
- not an item of the list
`;

const TASKS = `## 9. Teams
- [ ] 9.7 Change a member's role with the confirmation step.
- [x] 9.8 Remove a member with the confirmation step.
- [ ] 20.6 Export the activity log with the confirmation step.
`;

const changeRole = defineCommand({
  id: "members.change_role",
  summary: "Change a member's role.",
  input: z.object({ userId: z.uuid(), role: z.enum(["admin", "member"]) }),
  output: z.object({}),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "alpha",
});
const remove = defineCommand({
  id: "members.remove",
  summary: "Remove a member.",
  input: z.object({ userId: z.uuid() }),
  output: z.object({}),
  scopes: [],
  commitment: false,
  confirm: true,
  surfaces: [],
  stability: "alpha",
});
const getRequest = defineCommand({
  id: "requests.get",
  summary: "Read a request.",
  input: z.object({ key: z.string() }),
  output: z.object({}),
  method: "GET",
  path: "/api/v1/requests/{key}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest", "mcp", "cli"],
  tool: "get_request",
  cli: [{ command: "get" }],
  stability: "beta",
});

/** The catalog once 9.8 has built removing a member: one command that needs the confirmation step, and one that does not. */
const catalog: Catalog = defineCatalog([remove, getRequest]);
/** The catalog once 9.7 has built changing a role too. */
const withRoleChange: Catalog = defineCatalog([changeRole, remove, getRequest]);

const LEE = "6f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d6e";

/** The list as it stands once 9.8 has built removing a member, and 9.7 and 20.6 are still to come. */
function list(): { items: { item: string; actions: Record<string, unknown>[] }[] } {
  return {
    items: [
      {
        item: "changing a member's role, and removing a member;",
        actions: [
          { action: "changing a member's role", pending: "9.7" },
          { action: "removing a member", command: "members.remove", input: { userId: LEE } },
        ],
      },
      { item: "exporting the activity log.", actions: [{ action: "exporting the activity log", pending: "20.6" }] },
    ],
  };
}

const openapi = { paths: { "/api/v1/requests/{key}": { get: { operationId: "requests.get", "x-tiehall-cli": { commands: [{ command: "get" }] } } } } };
const tools = { tools: [{ name: "get_request" }] };

/** The inputs of the check, with the parts a case changes. */
function inputs(change: Partial<CoverageInputs> = {}): CoverageInputs {
  return { list: list(), specItems: specItems(SPEC), tasks: taskStates(TASKS), catalog, openapi, tools, ...change };
}

/** The list with one change to its first item's actions. */
function withActions(actions: Record<string, unknown>[]) {
  const changed = list();
  changed.items[0] = { item: changed.items[0]?.item ?? "", actions };
  return changed;
}

describe("the spec's list", () => {
  it("is read as the bullets of the requirement, and nothing of the next one", () => {
    expect(specItems(SPEC)).toEqual(["changing a member's role, and removing a member;", "exporting the activity log."]);
  });

  it("gives each task's state from the plan", () => {
    expect(taskStates(TASKS)).toEqual(
      new Map([
        ["9.7", false],
        ["9.8", true],
        ["20.6", false],
      ]),
    );
  });
});

describe("the confirmation coverage check", () => {
  it("passes a list that mirrors the spec, with built actions' commands and inputs and unbuilt actions' tasks", () => {
    expect(confirmationCoverageProblems(inputs())).toEqual([]);
  });

  it("fails an action that names neither its command nor the task that builds it", () => {
    const problems = confirmationCoverageProblems(inputs({ list: withActions([{ action: "changing a member's role" }, list().items[0]!.actions[1]!]) }));
    expect(problems).toEqual([
      'changing a member\'s role: it names neither its confirm command, with an input for its two cases, nor the task that builds it, as "pending": "<task>".',
    ]);
  });

  it("fails an action still pending on a task that is done, or on a task the plan does not hold", () => {
    expect(
      confirmationCoverageProblems(
        inputs({ list: withActions([{ action: "changing a member's role", pending: "9.8" }, list().items[0]!.actions[1]!]) }),
      ),
    ).toEqual(["changing a member's role: task 9.8 is done, so this action names its confirm command and an input for its two cases."]);
    expect(
      confirmationCoverageProblems(
        inputs({ list: withActions([{ action: "changing a member's role", pending: "99.1" }, list().items[0]!.actions[1]!]) }),
      ),
    ).toEqual(["changing a member's role: the plan has no task 99.1."]);
  });

  it("fails a command the catalog does not hold, or one that needs no confirmation step", () => {
    expect(
      confirmationCoverageProblems(
        inputs({
          catalog: withRoleChange,
          list: withActions([
            { action: "changing a member's role", command: "members.set_role", input: {} },
            { action: "removing a member", command: "requests.get", input: { key: "FE-142" } },
          ]),
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "changing a member's role: the catalog has no command members.set_role.",
        "removing a member: requests.get does not need the confirmation step (confirm: true).",
      ]),
    );
  });

  it("fails a built action whose two cases cannot run, because it gives no input its command's schema accepts", () => {
    const problems = confirmationCoverageProblems(
      inputs({
        catalog: withRoleChange,
        list: withActions([
          { action: "changing a member's role", command: "members.change_role", input: { userId: LEE, role: "owner" } },
          { action: "removing a member", command: "members.remove" },
        ]),
      }),
    );
    expect(problems).toEqual([
      "changing a member's role: its input fails the schema of members.change_role, so its two cases cannot run.",
      "removing a member: it gives no input for the two cases of members.remove.",
    ]);
  });

  it("fails a command that needs the confirmation step but is not listed for any action", () => {
    // 9.7 built the command, and the list still waits for 9.7.
    expect(confirmationCoverageProblems(inputs({ catalog: withRoleChange }))).toEqual([
      "members.change_role needs the confirmation step, but no action of the list names it.",
    ]);
  });

  it("fails a list that does not mirror the spec's items", () => {
    const missing = { items: [list().items[0]!] };
    expect(confirmationCoverageProblems(inputs({ list: missing }))).toEqual([
      'The list does not mirror agent-safety: Actions that need the confirmation step: the spec has "exporting the activity log." where the list has nothing.',
    ]);
    const reworded = { items: [list().items[0]!, { item: "exporting the log.", actions: [{ action: "exporting the log", pending: "20.6" }] }] };
    expect(confirmationCoverageProblems(inputs({ list: reworded }))).toEqual([
      'The list does not mirror agent-safety: Actions that need the confirmation step: the spec has "exporting the activity log." where the list has "exporting the log.".',
    ]);
  });

  it("fails a list that is not a list of items with actions", () => {
    expect(confirmationCoverageProblems(inputs({ list: { items: "none" } }))).toEqual([
      "The list is not { items: [{ item, actions: [{ action, command and input, or pending }] }] }.",
    ]);
  });

  it("fails when a confirm command is an operation of the OpenAPI document, is offered by the CLI or is an MCP tool", () => {
    const leakedDocument = {
      paths: {
        ...openapi.paths,
        "/api/v1/members/{userId}": { delete: { operationId: "members.remove", "x-tiehall-cli": { commands: [{ command: "member remove" }] } } },
      },
    };
    const leakedTools = { tools: [{ name: "get_request" }, { name: "remove_member", _meta: { operationId: "members.remove" } }] };
    expect(confirmationCoverageProblems(inputs({ openapi: leakedDocument, tools: leakedTools }))).toEqual([
      "members.remove needs the confirmation step, but openapi/v1.json offers it as DELETE /api/v1/members/{userId}.",
      "members.remove needs the confirmation step, but openapi/v1.json offers it on the CLI as member remove.",
      "members.remove needs the confirmation step, but mcp/tools.json offers it as the tool remove_member.",
    ]);
  });
});

describe("the check's script", () => {
  function check(root: string) {
    const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    if (run.error) throw run.error;
    return run;
  }

  it("fails a fixture tree whose list has an action without a command", () => {
    const run = check(fixture("entry-without-command"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('changing a member\'s role: it names neither its confirm command, with an input for its two cases, nor the task that builds it, as "pending": "<task>".');
  });

  it("passes the real tree, whose list mirrors the spec and names the task of every action still to be built", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^tools\/repo-checks\/confirmation-actions\.json mirrors the \d+ items of agent-safety: Actions that need the confirmation step/);
    expect(confirmationCoverageProblems(readCoverageInputs(repoRoot, CATALOG))).toEqual([]);
  });

  it("reads the list the commands' tests run the two cases from", () => {
    const committed = JSON.parse(readFileSync(new URL("../confirmation-actions.json", import.meta.url), "utf8")) as { items: unknown[] };
    expect(committed.items.length).toBe(readCoverageInputs(repoRoot, CATALOG).specItems.length);
  });
});
