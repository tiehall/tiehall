import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeDryRun } from "../src/renovate-dry-run.ts";

// The Renovate dry-run check for operations: Build pipeline integrity: no
// update is proposed before it is 7 days old. `pnpm check:renovate` runs
// Renovate's lookup against the real tree; these tests run the same script on
// committed Renovate JSON logs.

const script = fileURLToPath(new URL("../src/check-renovate.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/renovate-dry-run/${name}.jsonl`, import.meta.url));

function check(log: string) {
  const run = spawnSync(process.execPath, [script, "--log", log], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the Renovate dry-run check", () => {
  it("fails when Renovate would propose an update younger than 7 days, or one whose age it cannot tell", () => {
    const summary = summarizeDryRun(readFileSync(fixture("proposes-young-updates"), "utf8"));
    expect(summary.tooYoung.map((update) => [update.depName, update.updateType, update.ageDays])).toEqual([
      ["vitest", "patch", 0.5],
      ["node", "digest", undefined],
    ]);
    expect(summary.proposed.map((update) => update.depName)).toEqual(["vitest", "typescript", "node"]);
    expect(summary.disabled).toBe(0);

    const run = check(fixture("proposes-young-updates"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 update(s) younger than 7 days");
  });

  it("passes when every update younger than 7 days is held back, and lists what it could not look up", () => {
    const summary = summarizeDryRun(readFileSync(fixture("holds-young-updates"), "utf8"));
    expect(summary.tooYoung).toEqual([]);
    expect(summary.held.map((update) => update.depName)).toEqual(["vitest", "node"]);
    expect(summary.proposed).toEqual([
      expect.objectContaining({ depName: "typescript", updateType: "major", ageDays: 79.2, needsApproval: true }),
    ]);
    expect(summary.notLookedUp).toEqual([{ depName: "actions/checkout", reason: "github-token-required" }]);
    expect(summary.disabled).toBe(1);

    const run = check(fixture("holds-young-updates"));
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("1 update(s) proposed, 2 held back by the 7-day minimum release age");
    expect(run.stdout).toContain("actions/checkout (github-token-required)");
    expect(run.stdout).toContain("Renovate dropped 1 disabled update(s)");
    expect(run.status).toBe(0);
  });

  it("fails when Renovate did not finish its lookup", () => {
    expect(() => summarizeDryRun(readFileSync(fixture("unfinished"), "utf8"))).toThrow(/packageFiles with updates/);
    expect(check(fixture("unfinished")).status).toBe(2);
  });
});
