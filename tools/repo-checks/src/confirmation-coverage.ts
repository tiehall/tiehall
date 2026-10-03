import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog } from "@tiehall/catalog";
import { planFor, requirementListItems, taskStates } from "./plan.ts";

export { taskStates } from "./plan.ts";

// The confirmation coverage check (agent-safety: Actions that need the
// confirmation step; agent-safety: The confirmation step runs only in the web
// UI; agent-surfaces: Admin actions and trust changes are on no agent
// surface; design.md, Self-hosting decisions: S7). A committed list,
// tools/repo-checks/confirmation-actions.json, mirrors the spec's list of the
// actions that need the confirmation step: one item per bullet of the
// requirement, in the spec's order, each with the actions it names. An action
// names the task of the plan that builds it until that task does; from then on
// it names its confirm command and an input its command's schema accepts, with
// which the commands' tests run its two cases (a session and a CSRF token
// alone get 403; a nonce for another action gets 403) through the real
// catalog, handlers and review pages. The check fails:
// - when the list's items are not the spec's bullets, in order;
// - when an action names neither a command nor a task, a task the plan does
//   not hold, or a task that is done while the action still waits for it;
// - when a command is not in the catalog or does not need the confirmation
//   step, or its input is missing or fails the command's schema, so its two
//   cases cannot run;
// - when a command of the catalog needs the confirmation step but no action
//   names it;
// - when a command that needs the confirmation step is an operation of
//   openapi/v1.json, is offered there on the CLI, or is a tool of
//   mcp/tools.json.
// Against the full list (task 26.6), which the check runs on with --full once
// every group that builds an action is done, it also fails each action that
// still waits for its task.

/** Where the list lives, relative to the repository's root. */
export const CONFIRMATION_LIST = "tools/repo-checks/confirmation-actions.json";
/** The requirement the list mirrors. */
export const REQUIREMENT = "agent-safety: Actions that need the confirmation step";
const REQUIREMENT_NAME = "Actions that need the confirmation step";

/** An action of the list: built, with its command and an input for its two cases, or pending on the task that builds it. */
export type ConfirmationAction =
  | { action: string; command: string; input?: unknown; pending?: undefined }
  | { action: string; pending: string; command?: undefined; input?: undefined };

export interface ConfirmationList {
  items: { item: string; actions: ConfirmationAction[] }[];
}

export interface CoverageInputs {
  /** The committed list, as JSON parsed it. */
  list: unknown;
  /** The bullets of the spec's requirement, in order. */
  specItems: readonly string[];
  /** Each task of the plan, by its number, and whether it is done. */
  tasks: ReadonlyMap<string, boolean>;
  catalog: Catalog;
  /** openapi/v1.json, as JSON parsed it. */
  openapi: unknown;
  /** mcp/tools.json, as JSON parsed it. */
  tools: unknown;
}

/** The bullets of the requirement's list, each without its "- ". */
export function specItems(spec: string): string[] {
  return requirementListItems(spec, REQUIREMENT_NAME);
}

/** The list's built actions: those that name their confirm command. */
export function builtActions(list: ConfirmationList): { action: string; command: string; input: unknown }[] {
  return list.items.flatMap(({ actions }) =>
    actions.flatMap((entry) => (entry.command === undefined ? [] : [{ action: entry.action, command: entry.command, input: entry.input }])),
  );
}

function isList(value: unknown): value is ConfirmationList {
  if (typeof value !== "object" || value === null || !Array.isArray((value as ConfirmationList).items)) return false;
  return (value as ConfirmationList).items.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof item.item === "string" &&
      Array.isArray(item.actions) &&
      item.actions.every((entry) => typeof entry === "object" && entry !== null && typeof entry.action === "string"),
  );
}

/** How the check runs: on the list as it stands, or against the full list, in which no action waits for its task. */
export interface CoverageOptions {
  full?: boolean;
}

/** Every way the list and the surfaces break the rules above, as a sentence; none when they keep them. */
export function confirmationCoverageProblems(inputs: CoverageInputs, options: CoverageOptions = {}): string[] {
  const { list, catalog } = inputs;
  if (!isList(list)) return ["The list is not { items: [{ item, actions: [{ action, command and input, or pending }] }] }."];
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

  const named = new Set<string>();
  for (const entry of list.items.flatMap(({ actions }) => actions)) {
    const problem = (text: string) => problems.push(`${entry.action}: ${text}`);
    if (typeof entry.command === "string") {
      named.add(entry.command);
      const definition = catalog.get(entry.command);
      if (definition === undefined) problem(`the catalog has no command ${entry.command}.`);
      else if (!definition.confirm) problem(`${entry.command} does not need the confirmation step (confirm: true).`);
      else if (!("input" in entry) || entry.input === undefined) problem(`it gives no input for the two cases of ${entry.command}.`);
      else if (!definition.input.safeParse(entry.input).success) {
        problem(`its input fails the schema of ${entry.command}, so its two cases cannot run.`);
      }
    } else if (typeof entry.pending === "string") {
      const done = inputs.tasks.get(entry.pending);
      if (done === undefined) problem(`the plan has no task ${entry.pending}.`);
      else if (done) problem(`task ${entry.pending} is done, so this action names its confirm command and an input for its two cases.`);
      else if (options.full === true) problem(`it still waits for task ${entry.pending}, so the list is not full: every action names its confirm command.`);
    } else {
      problem('it names neither its confirm command, with an input for its two cases, nor the task that builds it, as "pending": "<task>".');
    }
  }

  const confirmCommands = catalog.commands.filter(({ confirm }) => confirm);
  for (const { id } of confirmCommands) {
    if (!named.has(id)) problems.push(`${id} needs the confirmation step, but no action of the list names it.`);
  }
  for (const definition of confirmCommands) {
    for (const [route, operation] of operationsOf(inputs.openapi)) {
      if (operation["operationId"] !== definition.id) continue;
      problems.push(`${definition.id} needs the confirmation step, but openapi/v1.json offers it as ${route}.`);
      const commands = (operation["x-tiehall-cli"] as { commands?: unknown } | undefined)?.commands;
      for (const command of Array.isArray(commands) ? commands : []) {
        const name = (command as { command?: unknown } | null)?.command;
        problems.push(`${definition.id} needs the confirmation step, but openapi/v1.json offers it on the CLI as ${String(name)}.`);
      }
    }
    for (const tool of toolsOf(inputs.tools)) {
      const operationId = (tool["_meta"] as { operationId?: unknown } | undefined)?.operationId;
      if (operationId === definition.id || (definition.tool !== undefined && tool["name"] === definition.tool)) {
        problems.push(`${definition.id} needs the confirmation step, but mcp/tools.json offers it as the tool ${String(tool["name"])}.`);
      }
    }
  }
  return problems;
}

/** Every operation of an OpenAPI document, as "METHOD path" and the operation object. */
function operationsOf(document: unknown): [string, Record<string, unknown>][] {
  const paths = (document as { paths?: unknown } | null)?.paths;
  if (typeof paths !== "object" || paths === null) return [];
  return Object.entries(paths as Record<string, unknown>).flatMap(([path, item]) =>
    typeof item === "object" && item !== null
      ? Object.entries(item as Record<string, unknown>).flatMap(([method, operation]) =>
          typeof operation === "object" && operation !== null
            ? [[`${method.toUpperCase()} ${path}`, operation as Record<string, unknown>] as [string, Record<string, unknown>]]
            : [],
        )
      : [],
  );
}

/** Every tool of the MCP tool snapshot. */
function toolsOf(snapshot: unknown): Record<string, unknown>[] {
  const tools = (snapshot as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) ? tools.filter((tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null) : [];
}

/** Reads the check's inputs from a repository's root, with the catalog the checked code builds. */
export function readCoverageInputs(root: string, catalog: Catalog): CoverageInputs {
  const plan = planFor(root, "agent-safety", REQUIREMENT_NAME);
  const json = (file: string): unknown => JSON.parse(readFileSync(join(root, file), "utf8"));
  return {
    list: json(CONFIRMATION_LIST),
    specItems: plan === undefined ? [] : specItems(plan.spec),
    tasks: taskStates(plan?.tasks ?? ""),
    catalog,
    openapi: json("openapi/v1.json"),
    tools: json("mcp/tools.json"),
  };
}
