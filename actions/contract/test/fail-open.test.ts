import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cliStandIn, type CliCall, type InstallAnswer } from "./support/cli.ts";
import { runActionWith, type RunOptions } from "./support/runner.ts";

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
