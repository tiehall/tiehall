import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The conformance fixtures of the handoff packet and their runner
// (handoff-packet: The Apache-2.0 schema directory; handoff-packet: The packet
// format). The fixtures are packets written as JSON files, each in the folder
// that says what a validator must make of it: fixtures/valid holds packets
// that every conforming validator accepts, and fixtures/invalid packets that
// every conforming validator refuses. A file's name says what it shows, such
// as invalid/no-need.json. The runner takes any validator, whether it checks
// against the JSON Schema or against Tiehall's own definition, runs it over
// every fixture, and reports each fixture whose outcome differs from its
// folder. It uses only Node's built-ins, so anyone can run it against their
// own validator.

/** What a conforming validator makes of a fixture: it accepts a valid one and refuses an invalid one. */
export const EXPECTATIONS = ["valid", "invalid"] as const;
export type Expectation = (typeof EXPECTATIONS)[number];

export interface Fixture {
  /** The fixture's path under the fixtures folder, such as invalid/no-need.json. */
  name: string;
  expected: Expectation;
  /** The packet, parsed from the file. */
  packet: unknown;
}

/** Decides whether a packet conforms: true to accept it, false to refuse it. A validator that throws refuses nothing. */
export type Validator = (packet: unknown) => boolean;

export interface CaseResult {
  fixture: Fixture;
  /** Whether the validator's outcome matches the fixture's folder. */
  passed: boolean;
  /** Why it did not pass, in the runner's words. */
  problem?: string;
}

/** The fixtures folder of this directory. */
export const FIXTURES_FOLDER = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** A fixtures folder that breaks the layout; its message names every problem, one per line. */
export class FixtureError extends Error {
  override name = "FixtureError";
}

/**
 * Every fixture of a fixtures folder, valid ones first, each group in the
 * order of its file names. The folder holds exactly the folders valid and
 * invalid, and they hold only JSON files, each of which parses.
 */
export function loadFixtures(folder: string = FIXTURES_FOLDER): Fixture[] {
  const problems: string[] = [];
  const fixtures: Fixture[] = [];
  const entries = readdirSync(folder, { withFileTypes: true }).filter(({ name }) => !name.startsWith("."));
  for (const entry of entries) {
    if (!entry.isDirectory() || !(EXPECTATIONS as readonly string[]).includes(entry.name)) {
      problems.push(`${entry.name}: the fixtures folder holds only the folders ${EXPECTATIONS.join(" and ")}.`);
    }
  }
  for (const expected of EXPECTATIONS) {
    const files = entries.some((entry) => entry.isDirectory() && entry.name === expected)
      ? readdirSync(join(folder, expected), { withFileTypes: true }).filter(({ name }) => !name.startsWith("."))
      : [];
    if (files.length === 0) problems.push(`${expected}: the folder holds no fixture.`);
    for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = `${expected}/${file.name}`;
      if (!file.isFile() || !file.name.endsWith(".json")) {
        problems.push(`${name}: a fixture is a .json file.`);
        continue;
      }
      try {
        fixtures.push({ name, expected, packet: JSON.parse(readFileSync(join(folder, name), "utf8")) as unknown });
      } catch {
        problems.push(`${name}: the file is not JSON.`);
      }
    }
  }
  if (problems.length > 0) throw new FixtureError(problems.join("\n"));
  return fixtures;
}

/** Runs the validator over each fixture and says, for each, whether its outcome matches the fixture's folder. */
export function runConformance(validate: Validator, fixtures: readonly Fixture[] = loadFixtures()): CaseResult[] {
  return fixtures.map((fixture) => {
    let accepted: boolean;
    try {
      accepted = validate(fixture.packet);
    } catch (error) {
      return { fixture, passed: false, problem: `the validator failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (accepted === (fixture.expected === "valid")) return { fixture, passed: true };
    return {
      fixture,
      passed: false,
      problem: fixture.expected === "valid" ? "the validator refused a valid fixture" : "the validator accepted an invalid fixture",
    };
  });
}

/** The report of a run: one line per fixture whose outcome differs from its folder; empty when every fixture passes. */
export function conformanceProblems(results: readonly CaseResult[]): string[] {
  return results.filter(({ passed }) => !passed).map(({ fixture, problem }) => `${fixture.name}: ${problem ?? "it did not pass"}.`);
}
