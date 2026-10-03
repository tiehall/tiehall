import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUSAL_REASONS } from "@tiehall/core";
import { errorModelCoverageProblems, readErrorModelInputs, type CoverageInputs } from "../src/error-model-coverage.ts";

// The error model's test coverage check (public-api: One error model for
// Tiehall's own refusals). A committed list,
// tools/repo-checks/error-model-tests.json, names for every row of the error
// model its test on REST, or why /api/v1 does not reach the row with the test
// of the HTTP endpoint that does, and its test on MCP, a tool error, or why
// tool errors do not apply to it. CI fails when a row names no such test, when
// a named test does not exist or does not run, when its file never names the
// row, and when a test on MCP does not read a tool error.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-error-model.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/error-model/${name}/`, import.meta.url));

/** The test files of a fixture tree, by path. */
const FILES: Readonly<Record<string, string>> = {
  "rest.test.ts": [
    'const CONFLICT = "https://tiehall.com/problems/conflict";',
    'it("answers a state conflict with 409", async () => {',
    "  expect(answer.body.type).toBe(CONFLICT);",
    "});",
    'it("answers a record that does not exist with 404", async () => {',
    "  expect(answer.body.type).toBe(`${PROBLEM}record-not-found`);",
    "});",
    'it.skip("answers a skipped refusal", async () => {});',
  ].join("\n"),
  "mcp.test.ts": [
    'it("answers a conflict as a tool error", async () => {',
    "  expect(problemOf(result)).toMatchObject({ type: `${PROBLEM}conflict` });",
    "});",
    'it("answers a missing record over HTTP", async () => {',
    "  expect(response.status).toBe(404); // problems/record-not-found",
    "});",
  ].join("\n"),
};

const ROWS = ["conflict", "record-not-found"];

/** The conflict row's test on MCP, a tool error. */
const CONFLICT_ON_MCP = { file: "mcp.test.ts", case: "answers a conflict as a tool error" };

/** A list in which both rows name their tests. */
function list(): { rows: Record<string, unknown> } {
  return {
    rows: {
      conflict: { rest: { file: "rest.test.ts", case: "answers a state conflict with 409" }, mcp: CONFLICT_ON_MCP },
      "record-not-found": {
        rest: { file: "rest.test.ts", case: "answers a record that does not exist with 404" },
        mcp: { not: "The fixture's MCP answers a missing record over HTTP, not with a tool error.", test: { file: "mcp.test.ts", case: "answers a missing record over HTTP" } },
      },
    },
  };
}

function inputs(change: Partial<CoverageInputs> = {}): CoverageInputs {
  return { list: list(), rows: ROWS, readFile: (path) => FILES[path], ...change };
}

/** The list with one row's entry changed. */
function withRow(row: string, entry: unknown): { rows: Record<string, unknown> } {
  const changed = list();
  changed.rows[row] = entry;
  return changed;
}

describe("the error model's test coverage check", () => {
  it("passes a list that names each row's test on REST and its tool error, or why MCP gives none, with the test of its HTTP status", () => {
    expect(errorModelCoverageProblems(inputs())).toEqual([]);
  });

  it("fails a row of the error model the list does not name, as a fixture row without a test shows", () => {
    const { rows } = list();
    delete rows["conflict"];
    expect(errorModelCoverageProblems(inputs({ list: { rows } }))).toEqual([
      "conflict is a row of the error model with no test on REST, and no test or word on MCP: name them in tools/repo-checks/error-model-tests.json.",
    ]);
  });

  it("fails a row the error model does not hold", () => {
    const named = withRow("teapot", { rest: { not: "A teapot is no row of Tiehall's error model at all." }, mcp: { not: "A teapot is no row of Tiehall's error model at all." } });
    expect(errorModelCoverageProblems(inputs({ list: named }))).toContain("teapot is no row of the error model, so the list names no test for it.");
  });

  it("fails a test file that is not one, a title no running test carries, and a file that never names the row", () => {
    const missingFile = withRow("conflict", { rest: { file: "nowhere.test.ts", case: "answers a state conflict with 409" }, mcp: CONFLICT_ON_MCP });
    expect(errorModelCoverageProblems(inputs({ list: missingFile }))).toEqual(["conflict, on REST: nowhere.test.ts is not a test file of the repository."]);
    const skipped = withRow("conflict", { rest: { file: "rest.test.ts", case: "answers a skipped refusal" }, mcp: CONFLICT_ON_MCP });
    expect(errorModelCoverageProblems(inputs({ list: skipped }))).toEqual(['conflict, on REST: rest.test.ts holds no test titled "answers a skipped refusal" that runs.']);
    const unnamed = withRow("record-not-found", { rest: { file: "rest.test.ts", case: "answers a record that does not exist with 404", names: "410 Gone" }, mcp: { not: "The fixture's MCP gives no tool error for this row at all." } });
    expect(errorModelCoverageProblems(inputs({ list: unnamed }))).toEqual([
      'record-not-found, on REST: rest.test.ts never names the row, as "410 Gone", so its test does not show the refusal.',
    ]);
  });

  it("fails a test on MCP that does not read a tool error, and a row that names neither a test nor why", () => {
    const notAToolError = withRow("record-not-found", {
      rest: { file: "rest.test.ts", case: "answers a record that does not exist with 404" },
      mcp: { file: "mcp.test.ts", case: "answers a missing record over HTTP" },
    });
    expect(errorModelCoverageProblems(inputs({ list: notAToolError }))).toEqual([
      'record-not-found, on MCP: the test "answers a missing record over HTTP" does not read a tool error: its result\'s isError or its problem.',
    ]);
    const silent = withRow("conflict", { rest: { not: "no" }, mcp: {} });
    expect(errorModelCoverageProblems(inputs({ list: silent }))).toEqual([
      "conflict, on REST: it says too little of why the surface gives no answer of /api/v1.",
      "conflict, on REST: it names no test of the HTTP endpoint that gives the refusal.",
      "conflict, on MCP: it names neither its test, as { file, case }, nor why the surface gives no tool error, as { not }.",
    ]);
  });

  it("fails a list that is not a list of rows", () => {
    expect(errorModelCoverageProblems(inputs({ list: { rows: [] } }))).toEqual(["The list is not { rows: { <problem type>: { rest, mcp } } }."]);
  });
});

describe("the check's script", () => {
  function check(root: string) {
    const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    if (run.error) throw run.error;
    return run;
  }

  it("fails a fixture tree whose list names no test of one row", () => {
    const run = check(fixture("row-without-test"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("conflict is a row of the error model with no test on REST, and no test or word on MCP");
  });

  it("passes the real tree: every row of the error model has its tests", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`each of the ${Object.keys(REFUSAL_REASONS).length} rows of the error model`);
    expect(errorModelCoverageProblems(readErrorModelInputs(repoRoot, Object.keys(REFUSAL_REASONS)))).toEqual([]);
  });
});
