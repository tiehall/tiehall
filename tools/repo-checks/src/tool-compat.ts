import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addedEntries, API_BREAKING_LABEL, parseChangelog, type Changelog } from "@tiehall/catalog/changelog";
import { DEPRECATION_DAYS, stableRemovals, type CompatResult, type Finding } from "./api-compat.ts";
import { runOnDocuments } from "./oasdiff.ts";

// MCP tools follow the same compatibility rules (public-api: MCP tools follow
// the same compatibility rules; public-api: Notice before a breaking change is
// enforced in CI; public-api: The `api-breaking` label for urgent security
// fixes; design.md, Design rules: Public API). mcp/tools.json, the committed
// snapshot of every tool's name, description, input and output schemas, with
// the stability level and deprecation of its operation, is compared on every
// pull request: the snapshot at the pull request's merge base with the pull
// request's, by the same pinned oasdiff and with the same notice periods as
// openapi/v1.json. Each tool is read as one operation of an OpenAPI 3.1
// document, POST /tools/{name}, whose request body is the tool's input and
// whose answer is its output, so:
// - a beta tool is removed, or gains a required argument or loses an output
//   field, only on or after the sunset of a deprecation announced at least 14
//   days ahead, as its operation would be;
// - a stable tool only gains things: any breaking change fails, deprecated or
//   not, and so does the loss of an optional argument or an optional output
//   field, which oasdiff rates a warning or information (stableRemovals of
//   api-compat.ts; decisions-from-groups-15-28: design.md, Decisions this
//   change rests on: D55 (30)), so the new behavior ships under a new tool
//   name, and the old tool is removed only on or after a sunset announced at
//   least 180 days ahead, which the six months below make longer;
// - an alpha tool changes freely, and a tool's level never goes down.
// A breaking change to the tool of a stable operation adds a new tool name
// and keeps the old tool for at least six months, so the check also holds a
// stable tool to six calendar months, a little more than the 180 days oasdiff
// asks of a stable operation (public-api: MCP tools follow the same
// compatibility rules):
// - a deprecation of a stable tool that is new or changes, a sunset added to
//   one included, sets its sunset at least six months after the later of the
//   deprecation's day and today;
// - a stable tool is removed only once it was deprecated with a sunset, and
//   at least six months after the deprecation's day;
// - a new tool may not take the name of a stable tool that an earlier
//   snapshot on the base branch held, in a shape that breaks it: oasdiff
//   compares the two as it compares any tool, so the same tool may come back,
//   and a breaking change gets a new name instead.
// A tool the merge base's snapshot records no level for is read as alpha: the
// snapshot recorded no levels before this check existed, when every tool's
// operation was alpha. The api-breaking label lets a break through only with a
// changelog entry of kind breaking that the pull request adds to
// openapi/changelog.json; unlike openapi/v1.json, the snapshot has no version
// number to bump, and a tool offered on REST too bumps info.version through the
// OpenAPI check. A snapshot or a changelog that does not parse fails the check.

export const TOOL_SNAPSHOT = "mcp/tools.json";
const CHANGELOG = "openapi/changelog.json";

/** The calendar months a stable tool stays after its deprecation, at least. */
export const STABLE_TOOL_MONTHS = 6;

/** A tool as the snapshot records it. */
interface SnapshotTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** The id of the operation the tool runs; snapshots written before it was recorded have none. */
  operationId?: string;
  stability?: string;
  deprecated?: { since: string; sunset?: string };
}

/** A snapshot that is not the tools list the check can read; its message names the file. */
export class ToolSnapshotError extends Error {
  override name = "ToolSnapshotError";
}

/**
 * The snapshot, given as JSON text, as an OpenAPI 3.1 document with one
 * operation per tool, which oasdiff compares; throws ToolSnapshotError naming
 * mcp/tools.json when the snapshot cannot be read.
 */
export function toolDocument(snapshot: string): string {
  return toolsDocument(parseSnapshot(snapshot));
}

function toolsDocument(tools: readonly SnapshotTool[]): string {
  const paths: Record<string, unknown> = {};
  for (const tool of tools) {
    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        "x-stability-level": tool.stability ?? "alpha",
        ...(tool.deprecated === undefined ? {} : { deprecated: true, ...(tool.deprecated.sunset === undefined ? {} : { "x-sunset": tool.deprecated.sunset }) }),
        requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema } } },
        responses: { "200": { description: "The tool's result.", content: { "application/json": { schema: tool.outputSchema } } } },
      },
    };
  }
  // Both documents carry the same version, so oasdiff's version check says nothing about tools.
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Tiehall MCP tools", version: "0.0.0" }, paths });
}

function parseSnapshot(text: string): SnapshotTool[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ToolSnapshotError(`${TOOL_SNAPSHOT} is not JSON.`);
  }
  const tools = (value as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) throw new ToolSnapshotError(`${TOOL_SNAPSHOT} is a JSON object with a tools list.`);
  const problems: string[] = [];
  const names = new Set<string>();
  tools.forEach((tool: Partial<SnapshotTool> | null, index) => {
    const at = typeof tool?.name === "string" ? tool.name : `tools[${index}]`;
    if (typeof tool !== "object" || tool === null) return problems.push(`${at} is not an object.`);
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name)) problems.push(`${at}: name is a tool's name, such as get_request.`);
    else if (names.has(tool.name)) problems.push(`${at} is listed twice.`);
    else names.add(tool.name);
    if (typeof tool.description !== "string") problems.push(`${at}: description is a string.`);
    for (const key of ["inputSchema", "outputSchema"] as const) {
      if (typeof tool[key] !== "object" || tool[key] === null || Array.isArray(tool[key])) problems.push(`${at}: ${key} is a schema object.`);
    }
    if (tool.stability !== undefined && !["alpha", "beta", "stable"].includes(tool.stability)) problems.push(`${at}: stability is alpha, beta or stable.`);
    if (tool.deprecated !== undefined) {
      const { since, sunset } = tool.deprecated;
      if (typeof since !== "string" || !isDay(since)) problems.push(`${at}: deprecated.since is a calendar day, such as 2026-12-01.`);
      if (sunset !== undefined && (typeof sunset !== "string" || !isDay(sunset))) problems.push(`${at}: deprecated.sunset is a calendar day, such as 2026-12-15.`);
    }
    return undefined;
  });
  if (problems.length > 0) throw new ToolSnapshotError(`${TOOL_SNAPSHOT} does not list its tools as the check reads them:\n${problems.join("\n")}`);
  return tools as SnapshotTool[];
}

function isDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

/**
 * Compares a revision of the snapshot with its base, both as JSON text, by the
 * notice rules of their operations, and holds a stable tool to its six months;
 * `history` holds the earlier snapshots of the base branch, newest first, which
 * a new tool's name is looked up in, and `today` the day the notice counts from.
 */
export async function compareToolSnapshots(
  base: string,
  revision: string,
  options: { history?: readonly EarlierSnapshot[]; today?: string } = {},
): Promise<CompatResult> {
  const baseTools = parseSnapshot(base);
  const revisionTools = parseSnapshot(revision);
  const found = await breakingErrors(toolsDocument(baseTools), toolsDocument(revisionTools));
  // A sunset oasdiff already finds too close is reported once, in its words.
  const tooClose = new Set(found.filter(({ id }) => SUNSET_FINDINGS.has(id)).map(({ operationId }) => operationId));
  const own = await stableToolErrors(baseTools, revisionTools, options.history ?? [], options.today ?? new Date().toISOString().slice(0, 10));
  const errors = [...found, ...own.filter(({ id, operationId }) => !(id === "stable-tool-sunset-within-six-months" && tooClose.has(operationId)))];
  return { passed: errors.length === 0, errors };
}

/** oasdiff's findings of a sunset closer than the notice period. */
const SUNSET_FINDINGS = new Set(["api-sunset-date-too-small", "api-sunset-date-changed-too-small"]);

/** What breaks between two tool documents: oasdiff's error-level findings, and anything a stable tool loses. */
async function breakingErrors(base: string, revision: string): Promise<Finding[]> {
  return [...(await oasdiffErrors(base, revision)), ...(await stableRemovals(base, revision))];
}

/** oasdiff's error-level findings between two tool documents. */
async function oasdiffErrors(base: string, revision: string): Promise<Finding[]> {
  const run = await runOnDocuments(
    ["breaking", "--format=json", "--fail-on=ERR", `--deprecation-days-beta=${DEPRECATION_DAYS.beta}`, `--deprecation-days-stable=${DEPRECATION_DAYS.stable}`],
    base,
    revision,
  );
  let findings: Finding[];
  try {
    findings = JSON.parse(run.stdout) as Finding[];
  } catch {
    throw new Error(`oasdiff could not compare the tool snapshots (exit ${run.status}): ${run.stderr.trim()}`);
  }
  return findings
    .filter(({ level }) => level >= 3)
    .map(({ id, level, text, operationId, path }) => ({
      id,
      level,
      text,
      ...(operationId === undefined ? {} : { operationId }),
      ...(path === undefined ? {} : { path }),
    }));
}

/** A snapshot of mcp/tools.json at an earlier commit of the base branch. */
export interface EarlierSnapshot {
  commit: string;
  /** mcp/tools.json at that commit, as JSON text. */
  snapshot: string;
}

/** The calendar day a number of months after a day, on the last day of the month when that month is shorter. */
export function addMonths(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date, last))).toISOString().slice(0, 10);
}

/** The six months of a stable tool: its deprecation's sunset, its removal, and its name once removed. */
async function stableToolErrors(base: readonly SnapshotTool[], revision: readonly SnapshotTool[], history: readonly EarlierSnapshot[], today: string): Promise<Finding[]> {
  const errors: Finding[] = [];
  const error = (tool: string, id: string, text: string) => errors.push({ id, level: 3, text, operationId: tool, path: `/tools/${tool}` });
  const before = new Map(base.map((tool) => [tool.name, tool]));
  const after = new Map(revision.map((tool) => [tool.name, tool]));
  for (const tool of revision) {
    const { deprecated } = tool;
    if (tool.stability !== "stable" || deprecated?.sunset === undefined) continue;
    const was = before.get(tool.name);
    const unchanged = was?.stability === "stable" && was.deprecated?.since === deprecated.since && was.deprecated?.sunset === deprecated.sunset;
    if (unchanged) continue;
    const from = deprecated.since > today ? deprecated.since : today;
    const earliest = addMonths(from, STABLE_TOOL_MONTHS);
    if (deprecated.sunset < earliest) {
      error(
        tool.name,
        "stable-tool-sunset-within-six-months",
        `the stable tool's sunset \`${deprecated.sunset}\` is less than six months away: a stable tool stays at least six months after ${from}, so its sunset is \`${earliest}\` or later`,
      );
    }
  }
  for (const tool of base) {
    const { deprecated } = tool;
    if (tool.stability !== "stable" || after.has(tool.name) || deprecated === undefined) continue;
    // A removal before the sunset, or with no deprecation at all, is oasdiff's to report.
    if (deprecated.sunset === undefined) {
      error(tool.name, "stable-tool-removed-without-sunset", "the stable tool is removed although its deprecation set no sunset: a stable tool stays until a sunset at least six months after its deprecation");
    } else if (deprecated.sunset <= today && addMonths(deprecated.since, STABLE_TOOL_MONTHS) > today) {
      error(
        tool.name,
        "stable-tool-removed-within-six-months",
        `the stable tool is removed less than six months after its deprecation of \`${deprecated.since}\`: it stays until \`${addMonths(deprecated.since, STABLE_TOOL_MONTHS)}\` at least`,
      );
    }
  }
  const added = revision.filter((tool) => !before.has(tool.name));
  for (const tool of added) {
    const earlier = newestEarlier(history, tool.name);
    if (earlier === undefined || earlier.tool.stability !== "stable") continue;
    const { deprecated: _old, ...old } = earlier.tool;
    const breaks = await breakingErrors(toolsDocument([old]), toolsDocument([tool]));
    if (breaks.length > 0) {
      error(
        tool.name,
        "stable-tool-name-reused",
        `the tool takes the name of the stable tool ${tool.name} that ${earlier.commit.slice(0, 12)} held, in a shape that breaks it ` +
          `(${breaks.map(({ id }) => id).join(", ")}): a breaking change to a stable tool ships under a new tool name`,
      );
    }
  }
  return errors;
}

/** The newest earlier snapshot that holds a tool of this name, with that tool; none when no earlier snapshot does. */
function newestEarlier(history: readonly EarlierSnapshot[], name: string): { commit: string; tool: SnapshotTool } | undefined {
  for (const { commit, snapshot } of history) {
    let tools: SnapshotTool[];
    try {
      tools = parseSnapshot(snapshot);
    } catch {
      continue;
    }
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool !== undefined) return { commit, tool };
  }
  return undefined;
}

/** A pull request, as the check sees it: the snapshot and the changelog at its merge base and in it, and its labels. */
export interface ToolPullRequest {
  /** mcp/tools.json at the merge base. */
  base: string;
  /** mcp/tools.json in the pull request. */
  revision: string;
  labels: readonly string[];
  /** openapi/changelog.json at the merge base; undefined when it did not exist there. */
  changelogBase?: string;
  /** openapi/changelog.json in the pull request. */
  changelogRevision: string;
  /** The earlier snapshots of the base branch, newest first, that a new tool's name is looked up in; none when unread. */
  history?: readonly EarlierSnapshot[];
  /** Today, as a calendar day in UTC, which a stable tool's six months count from; the real day when unset. */
  today?: string;
}

export interface ToolPullRequestResult extends CompatResult {
  /** Whether the pull request carries the api-breaking label. */
  labelled: boolean;
  /** Why the check fails besides the breaking changes: a snapshot or a changelog that does not parse, or the label without its entry. */
  problems: string[];
}

/** The tool compatibility check of a pull request, with the api-breaking label's rule. */
export async function checkToolPullRequest(pullRequest: ToolPullRequest): Promise<ToolPullRequestResult> {
  const labelled = pullRequest.labels.includes(API_BREAKING_LABEL);
  const problems: string[] = [];
  let base: Changelog | undefined;
  let revision: Changelog | undefined;
  try {
    base = pullRequest.changelogBase === undefined ? undefined : parseChangelog(pullRequest.changelogBase);
  } catch {
    // An unparsable changelog at the merge base counts as none: every entry of the pull request's is new.
    base = undefined;
  }
  try {
    revision = parseChangelog(pullRequest.changelogRevision);
  } catch (error) {
    problems.push(`${CHANGELOG} does not parse:\n${(error as Error).message}`);
  }
  let errors: Finding[] = [];
  try {
    ({ errors } = await compareToolSnapshots(pullRequest.base, pullRequest.revision, {
      ...(pullRequest.history === undefined ? {} : { history: pullRequest.history }),
      ...(pullRequest.today === undefined ? {} : { today: pullRequest.today }),
    }));
  } catch (error) {
    if (!(error instanceof ToolSnapshotError)) throw error;
    problems.push(error.message);
  }
  if (errors.length > 0 && labelled && revision !== undefined && !addedEntries(base, revision).some(({ kind }) => kind === "breaking")) {
    problems.push(
      `The pull request carries the ${API_BREAKING_LABEL} label but adds no changelog entry of kind breaking to ${CHANGELOG}; ` +
        "add one under unreleased that says which tool breaks and why it could not wait for the notice.",
    );
  }
  const allowed = labelled && problems.length === 0;
  return { passed: problems.length === 0 && (errors.length === 0 || allowed), labelled, errors, problems };
}

/** The level a snapshot records for each tool, by name, for naming a finding; none when the snapshot does not parse. */
export function recordedLevels(snapshot: string): Map<string, string> {
  try {
    return new Map(parseSnapshot(snapshot).map(({ name, stability }) => [name, stability ?? "alpha"]));
  } catch {
    return new Map();
  }
}

/** The files the check reads for a pull request in a repository, at the merge base with the base ref and in the checkout. */
export interface ToolPullRequestFiles {
  /** The merge base's commit. */
  mergeBase: string;
  /** mcp/tools.json at the merge base; undefined when it did not exist there, so there is nothing to compare. */
  base?: string;
  revision: string;
  changelogBase?: string;
  changelogRevision: string;
  /** The earlier snapshots of the base branch, newest first, read only as far back as a tool the pull request adds is named. */
  history: EarlierSnapshot[];
}

/** Reads mcp/tools.json and openapi/changelog.json at the merge base of HEAD with the base ref, and in the checkout. */
export function readToolPullRequest(root: string, baseRef: string): ToolPullRequestFiles {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git("merge-base", baseRef, "HEAD").trim();
  const atMergeBase = (file: string): string | undefined => {
    try {
      return git("show", `${mergeBase}:${file}`);
    } catch {
      return undefined;
    }
  };
  const base = atMergeBase(TOOL_SNAPSHOT);
  const changelogBase = atMergeBase(CHANGELOG);
  const revision = readFileSync(join(root, TOOL_SNAPSHOT), "utf8");
  // A tool the pull request adds is looked up in the base branch's earlier snapshots, newest first, as far back as needed.
  const history: EarlierSnapshot[] = [];
  const wanted = new Set(namesIn(revision));
  for (const name of namesIn(base ?? "")) wanted.delete(name);
  if (base !== undefined && wanted.size > 0) {
    for (const commit of git("log", "--format=%H", mergeBase, "--", TOOL_SNAPSHOT).split("\n").filter(Boolean)) {
      let snapshot: string;
      try {
        snapshot = git("show", `${commit}:${TOOL_SNAPSHOT}`);
      } catch {
        continue;
      }
      history.push({ commit, snapshot });
      for (const name of namesIn(snapshot)) wanted.delete(name);
      if (wanted.size === 0) break;
    }
  }
  return {
    mergeBase,
    ...(base === undefined ? {} : { base }),
    revision,
    ...(changelogBase === undefined ? {} : { changelogBase }),
    changelogRevision: readFileSync(join(root, CHANGELOG), "utf8"),
    history,
  };
}

/** The names of a snapshot's tools; none when it does not parse. */
function namesIn(snapshot: string): string[] {
  try {
    return parseSnapshot(snapshot).map(({ name }) => name);
  } catch {
    return [];
  }
}
