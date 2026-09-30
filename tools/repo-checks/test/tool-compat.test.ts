import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPRECATION_DAYS } from "../src/api-compat.ts";
import { oasdiff } from "../src/oasdiff.ts";
import { checkToolPullRequest, toolDocument, type ToolPullRequest, type ToolPullRequestResult } from "../src/tool-compat.ts";

// MCP tools follow the same compatibility rules (public-api: MCP tools follow
// the same compatibility rules; public-api: Notice before a breaking change is
// enforced in CI; public-api: The `api-breaking` label for urgent security
// fixes; design.md, Design rules: Public API). CI compares mcp/tools.json at a
// pull request's merge base with the pull request's, with the same pinned
// oasdiff and the same notice periods as openapi/v1.json: each tool is read as
// an operation whose input is its request body and whose output is its
// answer, at the stability level and with the deprecation of its operation,
// which the snapshot records. So a beta tool is removed, or gains a required
// argument, only on or after the sunset of a deprecation announced at least
// 14 days ahead; a stable tool only gains things, a breaking change ships
// under a new tool name, and the old tool stays until a sunset at least 180
// days ahead; an alpha tool changes freely; and a tool's level never goes
// down. The api-breaking label lets a break through only with a changelog
// entry of kind breaking that the pull request adds.
//
// Each fixture pull request below is a pair of snapshots with dates relative to
// the day the test runs, because oasdiff measures the notice from today.

/** A calendar day this many days from today, in UTC. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

interface Tool {
  name: string;
  description: string;
  stability?: string;
  deprecated?: { since: string; sunset?: string };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const input = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

/** A tool of the snapshot: key and body arguments, the key required, and an output with an id and a state. */
function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `The ${name} tool.`,
    stability: "beta",
    inputSchema: input({ key: { type: "string" }, body: { type: "string" } }, ["key"]),
    outputSchema: { type: "object", properties: { id: { type: "string" }, state: { type: "string" } }, required: ["id", "state"] },
    ...overrides,
  };
}

const snapshot = (...tools: Tool[]) => `${JSON.stringify({ tools }, null, 2)}\n`;
const EMPTY_CHANGELOG = `${JSON.stringify({ unreleased: [], releases: [] }, null, 2)}\n`;

function pullRequest(base: Tool[], revision: Tool[], overrides: Partial<ToolPullRequest> = {}): ToolPullRequest {
  return {
    base: snapshot(...base),
    revision: snapshot(...revision),
    labels: [],
    changelogBase: EMPTY_CHANGELOG,
    changelogRevision: EMPTY_CHANGELOG,
    ...overrides,
  };
}

const ids = (result: ToolPullRequestResult) => result.errors.map(({ id, operationId }) => `${operationId ?? ""} ${id}`).sort();

beforeAll(async () => {
  // Downloads and verifies the pinned oasdiff once, when the cache does not hold it yet.
  await oasdiff();
}, 120_000);

describe("the tool compatibility check", () => {
  it("fails a fixture pull request that removes a tool while its operation is beta and has no notice", async () => {
    const result = await checkToolPullRequest(pullRequest([tool("claim"), tool("get_request")], [tool("get_request")]));
    expect(result.passed).toBe(false);
    expect(ids(result)).toEqual(["claim api-path-removed-without-deprecation"]);
    expect(result.problems).toEqual([]);
  });

  it("passes the removal of a beta tool once the sunset of its deprecation has come", async () => {
    const deprecated = tool("claim", { deprecated: { since: day(-20), sunset: day(-1) } });
    expect(await checkToolPullRequest(pullRequest([deprecated, tool("get_request")], [tool("get_request")]))).toEqual({
      passed: true,
      labelled: false,
      errors: [],
      problems: [],
    });
  });

  it("fails the removal of a beta tool before its sunset", async () => {
    const deprecated = tool("claim", { deprecated: { since: day(-5), sunset: day(10) } });
    expect(ids(await checkToolPullRequest(pullRequest([deprecated], [])))).toEqual(["claim api-path-removed-before-sunset"]);
  });

  it("fails a deprecation whose sunset is closer than the 14 days a beta tool gets, or the 180 a stable one gets", async () => {
    expect(DEPRECATION_DAYS).toEqual({ beta: 14, stable: 180 });
    const short = await checkToolPullRequest(pullRequest([tool("claim")], [tool("claim", { deprecated: { since: day(0), sunset: day(10) } })]));
    expect(ids(short)).toEqual(["claim api-sunset-date-too-small"]);
    const enough = await checkToolPullRequest(pullRequest([tool("claim")], [tool("claim", { deprecated: { since: day(0), sunset: day(20) } })]));
    expect(enough.passed).toBe(true);
    const stable = tool("claim", { stability: "stable" });
    const stableShort = await checkToolPullRequest(
      pullRequest([stable], [{ ...stable, deprecated: { since: day(0), sunset: day(30) } }]),
    );
    expect(ids(stableShort)).toEqual(["claim api-sunset-date-too-small"]);
  });

  it("fails a new required argument, an argument made required and a removed output field of a beta tool", async () => {
    const cases: [Partial<Tool>, string][] = [
      [{ inputSchema: input({ key: { type: "string" }, body: { type: "string" }, kind: { type: "string" } }, ["key", "kind"]) }, "new-required-request-property"],
      [{ inputSchema: input({ key: { type: "string" }, body: { type: "string" } }, ["key", "body"]) }, "request-property-became-required"],
      [{ outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, "response-required-property-removed"],
    ];
    for (const [change, id] of cases) {
      const result = await checkToolPullRequest(pullRequest([tool("post_message")], [tool("post_message", change)]));
      expect(ids(result), id).toEqual([`post_message ${id}`]);
      expect(result.passed).toBe(false);
    }
  });

  it("lets an alpha tool change freely, and any tool gain an optional argument, an output field, new words or a new tool", async () => {
    expect((await checkToolPullRequest(pullRequest([tool("claim", { stability: "alpha" })], []))).passed).toBe(true);
    const gained = tool("claim", {
      description: "Claim a request, said better.",
      inputSchema: input({ key: { type: "string" }, body: { type: "string" }, note: { type: "string" } }, ["key"]),
      outputSchema: { type: "object", properties: { id: { type: "string" }, state: { type: "string" }, claimant: { type: "string" } }, required: ["id", "state"] },
    });
    expect(await checkToolPullRequest(pullRequest([tool("claim")], [gained, tool("propose", { stability: "stable" })]))).toMatchObject({
      passed: true,
      errors: [],
    });
  });

  it("lets a stable tool only gain things: a breaking change fails even once it is deprecated, so it ships under a new tool name", async () => {
    const stable = tool("claim", { stability: "stable", deprecated: { since: day(-200), sunset: day(-10) } });
    const required = { ...stable, inputSchema: input({ key: { type: "string" }, body: { type: "string" } }, ["key", "body"]) };
    expect(ids(await checkToolPullRequest(pullRequest([stable], [required])))).toEqual(["claim request-property-became-required"]);
    // The new behavior under a new name, and the old tool kept, passes.
    const { deprecated: _notice, ...undeprecated } = required;
    const renamed: Tool = { ...undeprecated, name: "claim_with_body" };
    expect((await checkToolPullRequest(pullRequest([stable], [stable, renamed]))).passed).toBe(true);
    // The old tool goes once its sunset, at least 180 days after it was announced, has come.
    expect((await checkToolPullRequest(pullRequest([stable, renamed], [renamed]))).passed).toBe(true);
  });

  it("fails a tool whose stability level goes down", async () => {
    const result = await checkToolPullRequest(pullRequest([tool("claim", { stability: "stable" })], [tool("claim")]));
    expect(ids(result)).toEqual(["claim api-stability-decreased"]);
    expect((await checkToolPullRequest(pullRequest([tool("claim")], [tool("claim", { stability: "alpha" })]))).passed).toBe(false);
  });

  it("reads a tool the merge base's snapshot records no level for as alpha, as every tool was before the snapshot recorded levels", async () => {
    const { stability: _level, ...unrecorded } = tool("claim");
    expect((await checkToolPullRequest(pullRequest([unrecorded], [tool("claim", { stability: "alpha" })]))).passed).toBe(true);
    expect((await checkToolPullRequest(pullRequest([unrecorded], []))).passed).toBe(true);
  });

  it("passes a break with the api-breaking label and a breaking changelog entry the pull request adds, and fails with the label alone", async () => {
    const entry = { date: day(0), kind: "breaking", text: "claim is removed at once for an urgent security fix.", operationIds: ["requests.claim"] };
    const changelogRevision = `${JSON.stringify({ unreleased: [entry], releases: [] }, null, 2)}\n`;
    const labelled = await checkToolPullRequest(pullRequest([tool("claim")], [], { labels: ["api-breaking"], changelogRevision }));
    expect(labelled).toMatchObject({ passed: true, labelled: true, problems: [] });
    // The break is still reported, as the label allows.
    expect(ids(labelled)).toEqual(["claim api-path-removed-without-deprecation"]);
    const alone = await checkToolPullRequest(pullRequest([tool("claim")], [], { labels: ["api-breaking"] }));
    expect(alone.passed).toBe(false);
    expect(alone.problems).toEqual([expect.stringContaining("adds no changelog entry of kind breaking")]);
    // An entry already at the merge base allows nothing.
    const already = await checkToolPullRequest(
      pullRequest([tool("claim")], [], { labels: ["api-breaking"], changelogBase: changelogRevision, changelogRevision }),
    );
    expect(already.passed).toBe(false);
  });

  it("fails a snapshot that does not parse, naming mcp/tools.json", async () => {
    const result = await checkToolPullRequest({ ...pullRequest([], []), revision: "{ not json" });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("mcp/tools.json")]);
    expect(() => toolDocument(JSON.stringify({ tools: [{ name: "claim" }] }))).toThrow("mcp/tools.json");
  });

  it("passes the committed snapshot against itself, and reads each of its tools as an operation with its level", async () => {
    const committed = readFileSync(new URL("../../../mcp/tools.json", import.meta.url), "utf8");
    expect(await checkToolPullRequest({ ...pullRequest([], []), base: committed, revision: committed })).toMatchObject({ passed: true, errors: [] });
    const document = JSON.parse(toolDocument(committed)) as { paths: Record<string, { post: Record<string, unknown> }> };
    const tools = (JSON.parse(committed) as { tools: Tool[] }).tools;
    expect(Object.keys(document.paths)).toEqual(tools.map(({ name }) => `/tools/${name}`));
    for (const { name, stability } of tools) {
      expect(stability, name).toMatch(/^(alpha|beta|stable)$/);
      expect(document.paths[`/tools/${name}`]?.post).toMatchObject({ operationId: name, "x-stability-level": stability });
    }
  });
});

// The check as CI runs it, on a fixture pull request in a scratch repository
// whose history is built here: the script reads mcp/tools.json and
// openapi/changelog.json at the merge base with the base branch and in the
// pull request's checkout.
describe("the tool compatibility script", { timeout: 120_000 }, () => {
  const script = fileURLToPath(new URL("../src/check-tool-compat.ts", import.meta.url));
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-tool-compat-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): void {
    const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }

  /** A repository whose main branch holds these tools, and a pull request branch that changes them to those. */
  function repository(name: string, base: Tool[], revision: Tool[]): string {
    const repo = join(scratch, name);
    mkdirSync(join(repo, "mcp"), { recursive: true });
    mkdirSync(join(repo, "openapi"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "mcp", "tools.json"), snapshot(...base));
    writeFileSync(join(repo, "openapi", "changelog.json"), EMPTY_CHANGELOG);
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Start");
    git(repo, "checkout", "--quiet", "-b", "pull-request");
    writeFileSync(join(repo, "mcp", "tools.json"), snapshot(...revision));
    git(repo, "commit", "--quiet", "-am", "Change the tools");
    return repo;
  }

  function check(repo: string, labels: string[] = []) {
    const run = spawnSync(process.execPath, [script, "main", repo], {
      encoding: "utf8",
      env: { ...process.env, PR_LABELS: JSON.stringify(labels) },
    });
    if (run.error) throw run.error;
    return { status: run.status, output: run.stdout + run.stderr };
  }

  it("fails a pull request that removes a beta tool with no notice, and names the tool", () => {
    const result = check(repository("removes-beta-tool", [tool("claim"), tool("get_request")], [tool("get_request")]));
    expect(result.status).toBe(1);
    expect(result.output).toContain("mcp/tools.json breaks the notice rules");
    expect(result.output).toMatch(/claim \(beta\): .*\[api-path-removed-without-deprecation\]/);
  });

  it("passes a pull request that removes an alpha tool", () => {
    const result = check(repository("removes-alpha-tool", [tool("claim", { stability: "alpha" })], []));
    expect(result.status).toBe(0);
    expect(result.output).toContain("mcp/tools.json keeps the notice rules");
  });
});
