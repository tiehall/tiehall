import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OASDIFF_FIXTURES } from "../src/oasdiff-fixtures.ts";
import { cliStandIn, type CliCall, type InstallAnswer } from "./support/cli.ts";
import { archiveHolding, repositoryHolding, runActionWith, type RunOptions } from "./support/runner.ts";

// The Action fails open (contract-changes: The Action fails open;
// contract-changes: The Action reports to the install its workflow names;
// public-api: `contract.report` has its own version floor; design.md,
// Decisions this change rests on: D28 #76; design.md, Readings to confirm with
// the founder: R19). The PR check is never marked failed because Tiehall
// could not take the report: an install the runner cannot reach, an error
// answer and the 503 of an install restarting for an upgrade each let the job
// succeed, saying in the job summary that the report was not delivered; an
// install that asks for a newer CLI, with 400 upgrade-required, gets a warning
// annotation and a summary that say how to upgrade. fail-on-breaking still
// fails the check for breaking changes when the install cannot be reached,
// since that result comes from the diff the Action computed. Here the CLI of
// this repository runs in the test's process as the pinned CLI, and the
// install answers as each case needs.

const scratch = mkdtempSync(join(tmpdir(), "tiehall-contract-fail-open-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROBLEMS = "https://tiehall.com/problems/";

/** Runs the Action on the breaking pair with an install that answers every report this way. */
async function runAnswered(answer: InstallAnswer, options: RunOptions = {}) {
  const calls: CliCall[] = [];
  const run = await runActionWith(scratch, { pair: "breaking", npx: cliStandIn(calls, () => answer), ...options });
  return { ...run, calls };
}

describe("a report the install does not take", () => {
  it("lets the job succeed when the install cannot be reached, and the summary says the report was not delivered", async () => {
    const run = await runAnswered("unreachable");

    expect(run.code).toBe(0);
    expect(run.calls.at(-1)?.url).toBe("https://tiehall.example.com/api/v1/contract-reports");
    expect(run.stdout).toMatch(/^::warning title=Report not delivered::.*could not be reached/m);
    expect(run.stdout).not.toMatch(/^::error/m);
    expect(run.summary).toContain("The report was not delivered to Tiehall at https://tiehall.example.com");
    expect(run.outputs).toMatchObject({ reported: "false", "breaking-changes": "2" });
  });

  it.each([
    ["an internal error", { status: 500, body: { type: "about:blank", title: "Internal Server Error", status: 500 } }],
    ["a refusal of the CI caller", { status: 403, body: { type: `${PROBLEMS}ci-caller-refused`, title: "Not allowed for CI", status: 403, detail: "This run may not report for payments-api." } }],
    ["an answer that is no problem at all", { status: 502, body: "Bad gateway" }],
  ])("lets the job succeed after %s", async (_case, answer) => {
    const run = await runAnswered(answer);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Report not delivered::/m);
    expect(run.summary).toContain("The report was not delivered");
    expect(run.outputs["reported"]).toBe("false");
  });

  it("lets the job succeed while the install restarts for an upgrade and answers 503", async () => {
    const run = await runAnswered({
      status: 503,
      body: { type: `${PROBLEMS}shutting-down`, title: "Shutting down", status: 503, detail: "Tiehall is restarting; try again." },
      headers: { "retry-after": "0" },
    });

    expect(run.code).toBe(0);
    expect(run.summary).toContain("The report was not delivered");
  });

  it("lets the job succeed when the CLI cannot even be started", async () => {
    const run = await runActionWith(scratch, {
      npx: async () => {
        throw Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
      },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Report not delivered::/m);
    expect(run.outputs["reported"]).toBe("false");
  });

  it("succeeds with a warning annotation and a summary that say how to upgrade, when the install answers 400 upgrade-required", async () => {
    const run = await runAnswered({
      status: 400,
      body: {
        type: `${PROBLEMS}upgrade-required`,
        title: "Upgrade required",
        status: 400,
        detail: "This install needs the tiehall CLI 0.4.0 or later for contract reports.",
      },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Tiehall needs a newer contract Action::.*newer release of the contract Action/m);
    expect(run.summary).toContain("Tiehall needs a newer contract Action");
    expect(run.summary).toContain("This install needs the tiehall CLI 0.4.0 or later for contract reports.");
    expect(run.summary).toMatch(/pin a newer release of the contract Action/i);
    expect(run.outputs["reported"]).toBe("false");
  });
});

describe("fail-on-breaking", () => {
  it("still fails the check for breaking changes when the install cannot be reached, and the summary says the report was not delivered", async () => {
    const run = await runAnswered("unreachable", { inputs: { "fail-on-breaking": "true" } });

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^::error title=Breaking changes::2 breaking changes to payments-api/m);
    expect(run.summary).toContain("The report was not delivered to Tiehall at https://tiehall.example.com");
    expect(run.summary).toContain("The step fails because of the breaking changes, as fail-on-breaking asks.");
  });

  it("fails nothing for a pull request without breaking changes when the install cannot be reached", async () => {
    const calls: CliCall[] = [];
    const run = await runActionWith(scratch, { pair: "warning", inputs: { "fail-on-breaking": "true" }, npx: cliStandIn(calls, () => "unreachable") });
    expect(run.code).toBe(0);
  });
});

// Every failure but a checksum mismatch fails open too (contract-changes: The
// Action fails open; decisions-from-groups-15-28, D55 (62); design.md,
// Technical decisions: T14): a download of the diff engine that the runner's
// network blocks, a document with external $refs, which the Action does not
// follow, a pull request that deletes the document, and an install that
// refuses the report with 400, such as for more than 1,000 changes, or with
// 413 each end the job successfully, with a warning annotation and a job
// summary that say what happened. Only a downloaded engine whose checksum is
// not the pinned one fails the step, and runs nothing. fail-on-breaking fails
// the check for breaking changes the Action computed, and never for a diff it
// could not compute.
describe("a diff the Action cannot compute or Tiehall refuses", () => {
  const breakingBase = readFileSync(join(OASDIFF_FIXTURES, "breaking", "base.yaml"), "utf8");
  /** The breaking pair's revision, whose response now names a schema in another file. */
  const withExternalRef = `${readFileSync(join(OASDIFF_FIXTURES, "breaking", "revision.yaml"), "utf8")}components:
  schemas:
    Refund:
      $ref: "./schemas/refund.yaml#/Refund"
`;

  it("ends the job successfully when the download of the diff engine is blocked, and says that no diff was computed", async () => {
    const calls: CliCall[] = [];
    const run = await runActionWith(scratch, { downloadBlocked: true, npx: cliStandIn(calls) });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Diff engine not downloaded::The pinned oasdiff [\d.]+ could not be downloaded from GitHub/m);
    expect(run.stdout).not.toMatch(/^::error/m);
    expect(run.summary).toContain("No diff was computed and no report was sent, so no consuming team was told of this pull request's changes.");
    expect(run.summary).toContain("The check is not failed for it.");
    expect(run.reports).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("ends the job successfully when the document holds external $refs, and says that the Action does not follow them", async () => {
    const repository = repositoryHolding(scratch, "external-ref", { base: breakingBase, head: withExternalRef });

    const run = await runActionWith(scratch, { repository });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=External \$refs not followed::openapi\/payments\.yaml holds external \$refs/m);
    expect(run.summary).toContain("./schemas/refund.yaml#/Refund");
    expect(run.summary).toContain("No diff was computed and no report was sent");
    expect(run.reports).toEqual([]);
  });

  it("ends the job successfully when the pull request deletes the document, and says so", async () => {
    const repository = repositoryHolding(scratch, "deleted", { base: breakingBase, head: undefined });

    const run = await runActionWith(scratch, { repository });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Document deleted::Pull request #310 deletes openapi\/payments\.yaml/m);
    expect(run.summary).toContain("No diff was computed and no report was sent");
    expect(run.reports).toEqual([]);
  });

  it("ends the job successfully when the install refuses a report of 1,001 changes with 400, and says that no consuming team was told", async () => {
    // 1,001 operations, each removed by the pull request: oasdiff classifies 1,001 changes.
    const many = Array.from({ length: 1001 }, (_, index) => `  /payments/${index}:\n    get:\n      responses:\n        "200":\n          description: A payment.\n`).join("");
    const repository = repositoryHolding(scratch, "many-changes", {
      base: `openapi: 3.1.0\ninfo:\n  title: Payments API\n  version: 1.4.0\npaths:\n${many}`,
      head: "openapi: 3.1.0\ninfo:\n  title: Payments API\n  version: 2.0.0\npaths: {}\n",
    });
    const calls: CliCall[] = [];
    const install = cliStandIn(calls, () => ({
      status: 400,
      body: {
        type: `${PROBLEMS}invalid-input`,
        title: "Invalid input",
        status: 400,
        detail: "The input does not match the operation's schema.",
        errors: [{ path: ["changes"], message: "Too big: expected array to have <=1000 items" }],
      },
    }));

    const run = await runActionWith(scratch, { repository, npx: install });

    expect(run.code).toBe(0);
    expect((calls.at(-1)?.body as { changes: unknown[] }).changes).toHaveLength(1001);
    expect(run.stdout).toMatch(/^::warning title=Report refused::Tiehall at https:\/\/tiehall\.example\.com refused the report/m);
    expect(run.summary).toContain("Invalid input: The input does not match the operation's schema. (HTTP 400)");
    expect(run.summary).toContain("The pull request makes 1001 changes, and one report takes at most 1,000.");
    expect(run.summary).toContain("No consuming team was told of this pull request's changes.");
    expect(run.summary).not.toContain("the next run of the Action reports again");
    expect(run.outputs).toMatchObject({ reported: "false", "breaking-changes": "1001" });
  }, 60_000);

  it.each([
    ["a problem", { status: 413, body: { type: `${PROBLEMS}payload-too-large`, title: "Request body too large", status: 413, detail: "The request body is larger than 16 MiB, the most Tiehall takes here, so it was not read and nothing ran." } }],
    ["a page of a proxy in front of the install", { status: 413, body: "<html>413 Request Entity Too Large</html>" }],
  ])("ends the job successfully when the install answers the report with 413 as %s, and says that the report was too large and no consuming team was told", async (_case, answer) => {
    const run = await runAnswered(answer);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Report too large::Tiehall at https:\/\/tiehall\.example\.com refused the report as too large/m);
    expect(run.summary).toContain("refused the report as too large");
    expect(run.summary).toContain("No consuming team was told of this pull request's changes.");
    expect(run.outputs["reported"]).toBe("false");
  });

  it("ends the job successfully on any other fault, such as a runner without git, and says what happened", async () => {
    const run = await runActionWith(scratch, { env: { PATH: join(scratch, "no-programs-here") } });

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^::warning title=Contract check not run::The contract check stopped: .*git/m);
    expect(run.summary).toContain("No diff was computed and no report was sent");
    expect(run.reports).toEqual([]);
  });

  it("fails the step on a diff engine whose checksum is not the pinned one, and runs nothing", async () => {
    const marker = join(scratch, "tampered-engine-ran");
    const calls: CliCall[] = [];

    const run = await runActionWith(scratch, { archive: archiveHolding(scratch, `#!/bin/sh\ntouch '${marker}'\necho '[]'\n`), npx: cliStandIn(calls) });

    expect(run.code).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(run.execs.filter(({ file }) => file !== "git")).toEqual([]);
    expect(calls).toEqual([]);
    expect(run.stdout).toMatch(/^::error title=oasdiff not verified::/m);
    expect(run.stdout).not.toMatch(/^::warning/m);
  });

  describe("with fail-on-breaking", () => {
    const failOnBreaking = { "fail-on-breaking": "true" };

    it("still fails the check for the breaking changes it computed when the install refuses the report with 413", async () => {
      const run = await runAnswered({ status: 413, body: { type: `${PROBLEMS}payload-too-large`, title: "Request body too large", status: 413 } }, { inputs: failOnBreaking });

      expect(run.code).toBe(1);
      expect(run.stdout).toMatch(/^::warning title=Report too large::/m);
      expect(run.stdout).toMatch(/^::error title=Breaking changes::2 breaking changes to payments-api/m);
    });

    it.each([
      ["the download of the diff engine is blocked", (): RunOptions => ({ downloadBlocked: true })],
      ["the document holds external $refs", (): RunOptions => ({ repository: repositoryHolding(scratch, "external-ref-failing", { base: breakingBase, head: withExternalRef }) })],
      ["the pull request deletes the document", (): RunOptions => ({ repository: repositoryHolding(scratch, "deleted-failing", { base: breakingBase, head: undefined }) })],
    ])("does not fail the check when %s, since no diff was computed", async (_case, options) => {
      const run = await runActionWith(scratch, { ...options(), inputs: failOnBreaking });

      expect(run.code).toBe(0);
      expect(run.stdout).not.toMatch(/^::error/m);
      expect(run.summary).toContain("No diff was computed");
    });
  });
});
