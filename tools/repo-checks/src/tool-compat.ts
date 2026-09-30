import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addedEntries, API_BREAKING_LABEL, parseChangelog, type Changelog } from "@tiehall/catalog/changelog";
import { DEPRECATION_DAYS, type CompatResult, type Finding } from "./api-compat.ts";
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
//   not, so the new behavior ships under a new tool name, and the old tool is
//   removed only on or after a sunset announced at least 180 days ahead;
// - an alpha tool changes freely, and a tool's level never goes down.
// A tool the merge base's snapshot records no level for is read as alpha: the
// snapshot recorded no levels before this check existed, when every tool's
// operation was alpha. The api-breaking label lets a break through only with a
// changelog entry of kind breaking that the pull request adds to
// openapi/changelog.json; unlike openapi/v1.json, the snapshot has no version
// number to bump, and a tool offered on REST too bumps info.version through the
// OpenAPI check. A snapshot or a changelog that does not parse fails the check.

export const TOOL_SNAPSHOT = "mcp/tools.json";
const CHANGELOG = "openapi/changelog.json";

/** A tool as the snapshot records it. */
interface SnapshotTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
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
  const tools = parseSnapshot(snapshot);
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

/** Compares a revision of the snapshot with its base, both as JSON text, by the notice rules of their operations. */
export async function compareToolSnapshots(base: string, revision: string): Promise<CompatResult> {
  const run = await runOnDocuments(
    ["breaking", "--format=json", "--fail-on=ERR", `--deprecation-days-beta=${DEPRECATION_DAYS.beta}`, `--deprecation-days-stable=${DEPRECATION_DAYS.stable}`],
    toolDocument(base),
    toolDocument(revision),
  );
  let findings: Finding[];
  try {
    findings = JSON.parse(run.stdout) as Finding[];
  } catch {
    throw new Error(`oasdiff could not compare the tool snapshots (exit ${run.status}): ${run.stderr.trim()}`);
  }
  const errors = findings
    .filter(({ level }) => level >= 3)
    .map(({ id, level, text, operationId, path }) => ({
      id,
      level,
      text,
      ...(operationId === undefined ? {} : { operationId }),
      ...(path === undefined ? {} : { path }),
    }));
  return { passed: errors.length === 0, errors };
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
    ({ errors } = await compareToolSnapshots(pullRequest.base, pullRequest.revision));
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
  return {
    mergeBase,
    ...(base === undefined ? {} : { base }),
    revision: readFileSync(join(root, TOOL_SNAPSHOT), "utf8"),
    ...(changelogBase === undefined ? {} : { changelogBase }),
    changelogRevision: readFileSync(join(root, CHANGELOG), "utf8"),
  };
}
