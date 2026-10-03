import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestReview, parseChecklist, parseReview, reviewProblems, securityReviewProblems } from "../src/security-review.ts";

// The security review checklist and its records (self-host-install: The
// setup code guards the setup screen; agent-safety: The confirmation step
// runs only in the web UI; activity-log: The activity log is append-only;
// design.md, Decisions this change rests on: D38). docs/security/ holds the
// checklist, whose items each name the requirements they check and the tests
// that hold them, or a gap mark, and a record of each review against it under
// docs/security/reviews/, named by its date. The check fails when an item of
// the checklist has no result in the latest record, when a record holds a
// result for an item the checklist does not have, when an item names a
// requirement the specs do not hold or a test file that does not hold the
// test's title, when an item names neither a test nor a gap, and when a
// finding a result names is not described in the record, or names no task of
// the plan that fixes it. The fixtures are inline texts, checked against
// stand-ins for the specs, the tests and the plan's tasks.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const CHECKLIST = [
  "# Security review checklist",
  "",
  "## Items",
  "",
  "### SR-1 The setup code",
  "",
  "- Requirement: setup-fixture: The setup code guards the setup screen",
  "- Check: the code carries 128 bits.",
  '- Test: `packages/commands/test/setup-code.test.ts`: "stores only a hash of the code"',
  "",
  "### SR-2 Jira webhooks",
  "",
  "- Requirement: tracker-mirrors: Jira webhooks are hints",
  "- Check: Tiehall re-reads the issue.",
  "- Gap: Jira webhooks are task 25.8.",
  "",
].join("\n");

const RECORD = [
  "# Security review of 2026-10-03",
  "",
  "## Results",
  "",
  "| Item | Result | Notes |",
  "|---|---|---|",
  "| SR-1 | Pass | The code is hashed. |",
  "| SR-2 | Gap | Not built yet. |",
  "",
].join("\n");

/** The specs and tests the fixtures name, as the real tree would hold them. */
const known = {
  requirementExists: (capability: string, name: string) =>
    (capability === "setup-fixture" && name === "The setup code guards the setup screen") || (capability === "tracker-mirrors" && name === "Jira webhooks are hints"),
  testExists: (file: string, title: string) => file === "packages/commands/test/setup-code.test.ts" && title === "stores only a hash of the code",
  taskExists: (task: string) => task === "26.15",
};

/** The record with a finding on SR-1, described with the task that fixes it. */
const WITH_FINDING = RECORD.replace("| SR-1 | Pass |", "| SR-1 | F1 |").concat(
  ["## Findings", "", "### F1 A trial install's cookies reach every server on localhost", "", "- Item: SR-1", "- Task: 26.15", ""].join("\n"),
);

describe("the security review checklist", () => {
  it("reads each item with its requirements, checks, tests and gaps", () => {
    expect(parseChecklist(CHECKLIST)).toEqual([
      {
        id: "SR-1",
        title: "The setup code",
        requirements: [{ capability: "setup-fixture", name: "The setup code guards the setup screen" }],
        checks: ["the code carries 128 bits."],
        tests: [{ file: "packages/commands/test/setup-code.test.ts", title: "stores only a hash of the code" }],
        gaps: [],
      },
      { id: "SR-2", title: "Jira webhooks", requirements: [{ capability: "tracker-mirrors", name: "Jira webhooks are hints" }], checks: ["Tiehall re-reads the issue."], tests: [], gaps: ["Jira webhooks are task 25.8."] },
    ]);
  });

  it("reads a record's result for each item", () => {
    expect(parseReview(RECORD).results).toEqual([
      { id: "SR-1", result: "Pass", notes: "The code is hashed." },
      { id: "SR-2", result: "Gap", notes: "Not built yet." },
    ]);
  });

  it("passes a checklist whose every item has a result, real requirements and tests that exist", () => {
    expect(reviewProblems({ checklist: CHECKLIST, record: RECORD, ...known })).toEqual([]);
  });

  it("fails an item without a result in the latest record, and a result for an item the checklist does not have", () => {
    const record = RECORD.replace("| SR-2 | Gap | Not built yet. |", "| SR-9 | Pass | Nothing. |");
    expect(reviewProblems({ checklist: CHECKLIST, record, ...known })).toEqual([
      "SR-2 has no result in the latest review record.",
      "The latest review record has a result for SR-9, which the checklist does not have.",
    ]);
  });

  it("fails a result that is neither Pass, Gap nor a finding", () => {
    const record = RECORD.replace("| SR-1 | Pass |", "| SR-1 | Fine |");
    expect(reviewProblems({ checklist: CHECKLIST, record, ...known })).toEqual(['SR-1\'s result "Fine" is not Pass, Gap or a finding such as F1.']);
  });

  it("fails an item that names a requirement the specs do not hold, or a test that does not exist", () => {
    const checklist = CHECKLIST.replace("The setup code guards the setup screen", "The setup code is long").replace('"stores only a hash of the code"', '"stores the code"');
    expect(reviewProblems({ checklist, record: RECORD, ...known })).toEqual([
      "SR-1 names setup-fixture: The setup code is long, which is no requirement of the specs.",
      'SR-1 names the test "stores the code" in packages/commands/test/setup-code.test.ts, which that file does not hold.',
    ]);
  });

  it("fails an item that names no requirement, and one that names neither a test nor a gap", () => {
    const checklist = CHECKLIST.replace("- Requirement: tracker-mirrors: Jira webhooks are hints\n", "").replace("- Gap: Jira webhooks are task 25.8.\n", "");
    expect(reviewProblems({ checklist, record: RECORD, ...known })).toEqual(["SR-2 names no requirement.", "SR-2 names neither a test nor a gap."]);
  });

  it("reads a record's findings, each with the tasks that fix it", () => {
    expect(parseReview(WITH_FINDING).findings).toEqual([{ id: "F1", title: "A trial install's cookies reach every server on localhost", tasks: ["26.15"] }]);
  });

  it("passes a finding the record describes, with a task of the plan", () => {
    expect(reviewProblems({ checklist: CHECKLIST, record: WITH_FINDING, ...known })).toEqual([]);
  });

  it("fails a finding that names no task, one whose task the plan does not have, and one the record does not describe", () => {
    expect(reviewProblems({ checklist: CHECKLIST, record: WITH_FINDING.replace("- Task: 26.15\n", ""), ...known })).toEqual(["F1 names no task that fixes it."]);
    expect(reviewProblems({ checklist: CHECKLIST, record: WITH_FINDING.replace("- Task: 26.15", "- Task: 26.99"), ...known })).toEqual(["F1 names task 26.99, which the plan does not have."]);
    expect(reviewProblems({ checklist: CHECKLIST, record: WITH_FINDING.replace("| SR-1 | F1 |", "| SR-1 | F1, F2 |"), ...known })).toEqual([
      "F2, which SR-1's result names, is not described in the latest review record.",
    ]);
  });

  it("finds the latest record by its date", () => {
    expect(latestReview(["2026-10-03.md", "2027-01-15.md", "README.md", "2026-12-31.md"])).toBe("2027-01-15.md");
    expect(latestReview(["README.md"])).toBeUndefined();
  });

  it("passes on the real tree: the checklist in docs/security and its latest record", () => {
    expect(securityReviewProblems(repoRoot)).toEqual([]);
  });
});
