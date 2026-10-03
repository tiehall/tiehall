import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The error model's test coverage check (public-api: One error model for
// Tiehall's own refusals; design.md, Decisions this change rests on: D28 #1).
// Every row of the error model, by the problem type packages/core names it
// with, has a test on REST and, where tool errors apply, on MCP. A committed
// list, tools/repo-checks/error-model-tests.json, names them: for each row,
//
// - its test on REST: a test file of the repository and the exact title of a
//   test in it; or why no operation of /api/v1 reaches the row, with the test
//   of the HTTP endpoint that does, such as the sign-in callback's;
// - its test on MCP: a test that shows the refusal as a tool error, whose own
//   text reads the tool result's isError or its problem; or why tool errors do
//   not apply to the row, with the test of /mcp's HTTP status where /mcp gives
//   one, such as the OAuth refusals', as the error model says.
//
// The check fails on a row of the error model the list does not name, on a
// row the list names that the error model does not hold, and on a test that
// is missing: a file that is not a test file of the repository, a title no
// test of that file carries (a skipped, expected-to-fail or to-do test does not
// count), a file that never names the row, by its problem type or by the text
// the entry gives, or a test on MCP that does not read a tool error. `pnpm
// test` runs the named tests; this check makes sure each row has them.

/** Where the list lives, relative to the repository's root. */
export const ERROR_MODEL_TEST_LIST = "tools/repo-checks/error-model-tests.json";

/** A test of the repository: its file, the exact title of a test in it, and what the file names the row by, when not its problem type. */
export interface RowTest {
  file: string;
  case: string;
  names?: string;
}

/** Why a surface does not reach a row, or gives it as an HTTP status, and the test of the endpoint that gives it, if any. */
export interface NotOnSurface {
  not: string;
  test?: RowTest;
}

export interface RowTests {
  rest: RowTest | NotOnSurface;
  mcp: RowTest | NotOnSurface;
}

export interface CoverageInputs {
  /** The committed list, as JSON parsed it. */
  list: unknown;
  /** The rows of the error model, by their problem types. */
  rows: readonly string[];
  /** The text of a file of the repository, by its path from the root; undefined when there is none. */
  readFile(path: string): string | undefined;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a test with exactly this title starts in a test file, when one runs; -1 when none does. */
function testStart(text: string, title: string): number {
  return new RegExp(`\\b(?:it|test)\\(\\s*(["'\`])${escape(title)}\\1`).exec(text)?.index ?? -1;
}

/** A test's own text: from its title to where the next test of the file starts. */
function testText(text: string, start: number): string {
  const next = /\n\s*(?:it|test)(?:\.[a-z]+(?:\([^)]*\))?)?\(/g;
  next.lastIndex = start + 1;
  const found = next.exec(text);
  return text.slice(start, found === null ? text.length : found.index);
}

function isRowTest(value: unknown): value is RowTest {
  return typeof value === "object" && value !== null && typeof (value as RowTest).file === "string" && typeof (value as RowTest).case === "string";
}

function isNotOnSurface(value: unknown): value is NotOnSurface {
  return typeof value === "object" && value !== null && typeof (value as NotOnSurface).not === "string";
}

/** Every way the list breaks the rules above, as a sentence; none when it keeps them. */
export function errorModelCoverageProblems(inputs: CoverageInputs): string[] {
  const rows = (inputs.list as { rows?: unknown } | null)?.rows;
  if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return ["The list is not { rows: { <problem type>: { rest, mcp } } }."];
  const listed = rows as Record<string, unknown>;
  const problems: string[] = [];

  /** Checks one test of a row; `toolError` asks that the test's own text reads a tool error. */
  const checkTest = (row: string, surface: string, test: RowTest, toolError: boolean): void => {
    const problem = (text: string) => problems.push(`${row}, on ${surface}: ${text}`);
    const text = test.file.endsWith(".test.ts") ? inputs.readFile(test.file) : undefined;
    if (text === undefined) {
      problem(`${test.file} is not a test file of the repository.`);
      return;
    }
    const start = testStart(text, test.case);
    if (start === -1) {
      problem(`${test.file} holds no test titled "${test.case}" that runs.`);
      return;
    }
    const names = test.names ?? row;
    const named = test.names === undefined ? new RegExp(`(?:problems/|\\})${escape(row)}\\b`).test(text) : text.includes(names);
    if (!named) problem(`${test.file} never names the row, as ${test.names === undefined ? `its problem type ${row}` : `"${names}"`}, so its test does not show the refusal.`);
    if (toolError && !/isError|problemOf\(/.test(testText(text, start))) problem(`the test "${test.case}" does not read a tool error: its result's isError or its problem.`);
  };

  for (const row of inputs.rows) {
    const entry = listed[row] as Partial<RowTests> | undefined;
    if (entry === undefined) {
      problems.push(`${row} is a row of the error model with no test on REST, and no test or word on MCP: name them in ${ERROR_MODEL_TEST_LIST}.`);
      continue;
    }
    for (const surface of ["rest", "mcp"] as const) {
      const named = entry[surface];
      const label = surface === "rest" ? "REST" : "MCP";
      if (isRowTest(named)) {
        checkTest(row, label, named, surface === "mcp");
      } else if (isNotOnSurface(named)) {
        if (named.not.trim().length < 30) problems.push(`${row}, on ${label}: it says too little of why the surface gives no ${surface === "rest" ? "answer of /api/v1" : "tool error"}.`);
        if (named.test !== undefined) {
          if (isRowTest(named.test)) checkTest(row, label, named.test, false);
          else problems.push(`${row}, on ${label}: its test is not { file, case }.`);
        } else if (surface === "rest") {
          problems.push(`${row}, on REST: it names no test of the HTTP endpoint that gives the refusal.`);
        }
      } else {
        problems.push(`${row}, on ${label}: it names neither its test, as { file, case }, nor why the surface ${surface === "rest" ? "does not reach it" : "gives no tool error"}, as { not }.`);
      }
    }
  }
  for (const row of Object.keys(listed)) {
    if (!inputs.rows.includes(row)) problems.push(`${row} is no row of the error model, so the list names no test for it.`);
  }
  return problems;
}

/** Reads the check's inputs from a repository's root, with the rows the checked code's error model holds. */
export function readErrorModelInputs(root: string, rows: readonly string[]): CoverageInputs {
  return {
    list: JSON.parse(readFileSync(join(root, ERROR_MODEL_TEST_LIST), "utf8")),
    rows,
    readFile: (path) => {
      const file = join(root, path);
      return !path.startsWith("/") && !path.split("/").includes("..") && existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
  };
}
