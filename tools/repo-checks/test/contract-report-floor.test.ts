import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Changelog } from "@tiehall/catalog/changelog";
import { FLOOR_NOTICE_DAYS, floorOf, floorRiseProblems } from "../src/contract-report-floor.ts";

// contract.report's own CLI floor rises only with 180 days' notice (public-api:
// `contract.report` has its own version floor; design.md, Design rules:
// Public API): companies' CI runs the CLI version the contract Action pins, so
// a floor that rises refuses their reports. A pull request that raises
// MINIMUM_CONTRACT_REPORT_CLI_VERSION passes only when the API changelog holds
// an entry about contract.report that names the new floor and is dated at
// least 180 days before the check runs.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TODAY = new Date("2027-06-01T12:00:00Z");

function changelog(...entries: { date: string; text: string; operationIds?: string[] }[]): Changelog {
  return { unreleased: entries.map((entry) => ({ kind: "note" as const, ...entry })), releases: [] };
}

describe("the floor of the CLI contract.report takes reports from", () => {
  it("is read from the source that keeps it", () => {
    expect(floorOf('export const MINIMUM_CONTRACT_REPORT_CLI_VERSION = "0.3.1";')).toBe("0.3.1");
    expect(floorOf("export const MINIMUM_CLI_VERSION = \"0.4.0\";")).toBeUndefined();
    expect(floorOf(readFileSync(`${root}packages/core/src/client-versions.ts`, "utf8"))).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("may stay as it was, or fall, with no notice", () => {
    expect(floorRiseProblems({ baseFloor: "0.2.0", floor: "0.2.0", changelog: changelog(), today: TODAY })).toEqual([]);
    expect(floorRiseProblems({ baseFloor: "0.2.0", floor: "0.1.0", changelog: changelog(), today: TODAY })).toEqual([]);
  });

  it("rises only with a changelog entry about contract.report that names the new floor, dated at least 180 days earlier", () => {
    expect(FLOOR_NOTICE_DAYS).toBe(180);
    const notice = (date: string, text = "From 2027-06-01, contract.report takes reports from tiehall 0.3.0 or later.", operationIds = ["contract.report"]) =>
      floorRiseProblems({ baseFloor: "0.2.0", floor: "0.3.0", changelog: changelog({ date, text, operationIds }), today: TODAY });
    expect(notice("2026-12-03")).toEqual([]);
    expect(notice("2026-12-04")).toEqual([
      "MINIMUM_CONTRACT_REPORT_CLI_VERSION rises from 0.2.0 to 0.3.0, but openapi/changelog.json gives no notice of it about contract.report, naming 0.3.0, dated 2026-12-03 or earlier: 180 days before the floor rises.",
    ]);
    expect(notice("2026-01-01", "contract.report will change.")).toHaveLength(1);
    expect(notice("2026-01-01", undefined, ["requests.get"])).toHaveLength(1);
    expect(floorRiseProblems({ baseFloor: "0.2.0", floor: "0.3.0", changelog: changelog(), today: TODAY })).toHaveLength(1);
  });

  it("takes the notice from a release's entries too, once a release carries it", () => {
    const released: Changelog = {
      unreleased: [],
      releases: [{ version: "1.2.0", date: "2026-11-01", apiVersion: "0.2.0", entries: [{ date: "2026-10-30", kind: "note", text: "contract.report: tiehall 0.3.0 or later from May 2027.", operationIds: ["contract.report"] }], changes: [] }],
    };
    expect(floorRiseProblems({ baseFloor: "0.2.0", floor: "0.3.0", changelog: released, today: TODAY })).toEqual([]);
  });
});

describe("the check's script", () => {
  // Against HEAD itself, so it runs in a shallow checkout too; CI's API compatibility job runs it against the merge base.
  it("passes the repository against a base where the floor is the same", () => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../src/check-contract-report-floor.ts", import.meta.url)), "HEAD"], { cwd: root, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/contract\.report's CLI floor/);
  });
});
