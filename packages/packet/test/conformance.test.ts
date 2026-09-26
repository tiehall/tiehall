import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conformanceProblems, FixtureError, loadFixtures, runConformance, type Fixture } from "../src/conformance.ts";

// The conformance fixtures and their runner (handoff-packet: The Apache-2.0
// schema directory; handoff-packet: The packet format). The directory holds
// valid and invalid packets as JSON files, and the runner reports every
// fixture a validator gets wrong. Which validator decides is up to whoever
// runs it: Tiehall runs its own packet definition over the fixtures in the
// catalog's tests, and the JSON Schema once the schema file is generated.

const temporary: string[] = [];

afterEach(() => {
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A fixtures folder with these files, by their paths under it. */
function folderWith(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), "tiehall-fixtures-"));
  temporary.push(folder);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
  return folder;
}

describe("the fixtures", () => {
  const fixtures = loadFixtures();
  const names = fixtures.map(({ name }) => name);

  it("holds valid and invalid packets, each once, valid ones first", () => {
    expect(new Set(names).size).toBe(names.length);
    const expectations = fixtures.map(({ expected }) => expected);
    expect(expectations.indexOf("invalid")).toBeGreaterThan(0);
    expect(expectations.slice(expectations.indexOf("invalid"))).not.toContain("valid");
    for (const { name, expected } of fixtures) expect(name.startsWith(`${expected}/`), name).toBe(true);
  });

  it("covers a request packet, a contract packet, a packet without a need and a contract-change packet without its contract section", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "valid/request-packet.json",
        "valid/contract-packet.json",
        "invalid/no-need.json",
        "invalid/contract-change-without-contract.json",
      ]),
    );
  });

  it("covers an unknown key, which the schema allows, and extensions under a namespace", () => {
    expect(names).toEqual(expect.arrayContaining(["valid/unknown-keys.json", "valid/extensions.json"]));
  });
});

describe("the runner", () => {
  const fixtures: Fixture[] = [
    { name: "valid/a.json", expected: "valid", packet: { need: "a" } },
    { name: "invalid/b.json", expected: "invalid", packet: {} },
  ];
  const hasNeed = (packet: unknown) => typeof packet === "object" && packet !== null && "need" in packet;

  it("passes each fixture whose outcome matches its folder", () => {
    const results = runConformance(hasNeed, fixtures);
    expect(results.map(({ passed }) => passed)).toEqual([true, true]);
    expect(conformanceProblems(results)).toEqual([]);
  });

  it("reports an invalid fixture that the validator accepts, and a valid one that it refuses", () => {
    expect(conformanceProblems(runConformance(() => true, fixtures))).toEqual(["invalid/b.json: the validator accepted an invalid fixture."]);
    expect(conformanceProblems(runConformance(() => false, fixtures))).toEqual(["valid/a.json: the validator refused a valid fixture."]);
  });

  it("fails every fixture on which the validator throws, naming why", () => {
    const results = runConformance(() => {
      throw new Error("no packet definition");
    }, fixtures);
    expect(results.map(({ passed }) => passed)).toEqual([false, false]);
    expect(conformanceProblems(results)).toEqual([
      "valid/a.json: the validator failed: no packet definition.",
      "invalid/b.json: the validator failed: no packet definition.",
    ]);
  });

  it("runs over the directory's own fixtures unless given others", () => {
    expect(runConformance(() => true).map(({ fixture }) => fixture.name)).toEqual(loadFixtures().map(({ name }) => name));
  });
});

describe("a fixtures folder", () => {
  it("is read from its valid and invalid folders, in the order of the files' names", () => {
    const folder = folderWith({ "invalid/z.json": "{}", "valid/b.json": '{"need":"b"}', "valid/a.json": '{"need":"a"}' });
    expect(loadFixtures(folder)).toEqual([
      { name: "valid/a.json", expected: "valid", packet: { need: "a" } },
      { name: "valid/b.json", expected: "valid", packet: { need: "b" } },
      { name: "invalid/z.json", expected: "invalid", packet: {} },
    ]);
  });

  it("is refused when it holds anything else, a file that is not JSON or an empty group, naming each problem", () => {
    const folder = folderWith({ "valid/a.json": "{", "valid/notes.txt": "", "extra/c.json": "{}" });
    expect(() => loadFixtures(folder)).toThrow(FixtureError);
    expect(() => loadFixtures(folder)).toThrow(
      [
        "extra: the fixtures folder holds only the folders valid and invalid.",
        "valid/a.json: the file is not JSON.",
        "valid/notes.txt: a fixture is a .json file.",
        "invalid: the folder holds no fixture.",
      ].join("\n"),
    );
  });
});
