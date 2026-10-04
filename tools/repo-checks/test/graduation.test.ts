import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { graduationProblems, QUIET_DAYS, readGraduationTree, STABLE_FROM_THE_START, type GraduationInput } from "../src/graduation.ts";

// The graduation check (public-api: Each operation graduates on its own;
// design.md, Design rules: Public API, Graduation, as S13 adapts it). An
// operation carries x-stability-level stable only once it has passed the
// graduation test: no breaking change to it was needed for four weeks, and the
// maintainers have decided to graduate it and recorded that decision in the
// changelog, as an entry of kind graduation that names it. There is no usage
// count, because installs send no usage data. contract.report, with the CI
// OIDC path a CI run calls it by, is stable from the start and exempt. CI runs
// the check on the committed documents (every openapi/v<N>.json), the tool
// snapshot (mcp/tools.json, for an operation offered only on MCP) and
// openapi/changelog.json, whose release records say when each release offered
// an operation and which breaking changes it carried.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-graduation.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/graduation/${name}/`, import.meta.url));

interface Operation {
  id: string;
  level: string;
  method?: string;
  path?: string;
}

/** An OpenAPI document holding these operations, as JSON text. */
function document(...operations: Operation[]): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { id, level, method = "get", path = `/api/v1/${id.replace(".", "/")}` } of operations) {
    paths[path] = { ...paths[path], [method]: { operationId: id, "x-stability-level": level, responses: { "200": { description: "OK" } } } };
  }
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Tiehall API", version: "0.4.0" }, paths });
}

/** A tool snapshot holding these tools, as JSON text. */
function tools(...listed: { name: string; operationId?: string; stability: string }[]): string {
  return JSON.stringify({ tools: listed.map((tool) => ({ description: `The ${tool.name} tool.`, inputSchema: { type: "object" }, outputSchema: { type: "object" }, ...tool })) });
}

type Entry = { date: string; kind: string; text: string; operationIds?: string[] };
type Change = { id: string; level: number; operationId?: string; text: string };

const graduation = (date: string, ...operationIds: string[]): Entry => ({
  date,
  kind: "graduation",
  text: `${operationIds.join(", ")} graduated: no breaking change was needed for four weeks.`,
  operationIds,
});
const breakingEntry = (date: string, operationId: string): Entry => ({ date, kind: "breaking", text: `${operationId} changed at once for an urgent security fix.`, operationIds: [operationId] });
const added = (operationId: string): Change => ({ id: "endpoint-added", level: 1, operationId, text: "endpoint added" });
const broken = (operationId: string): Change => ({ id: "request-property-became-required", level: 3, operationId, text: "the request property `note` became required" });
const release = (version: string, date: string, entries: Entry[] = [], changes: Change[] = []) => ({ version, date, apiVersion: "0.4.0", entries, changes });

/** A changelog with these unreleased entries and releases, the newest release first, as JSON text. */
function changelog(unreleased: Entry[], releases: ReturnType<typeof release>[] = []): string {
  return JSON.stringify({ unreleased, releases });
}

const TODAY = "2026-03-01";
/** The first release, which offered requests.get and contract.report on 5 January. */
const FIRST = release("1.0.0", "2026-01-05", [], [added("requests.get"), added("contract.report")]);

function input(overrides: Partial<GraduationInput> = {}): GraduationInput {
  return {
    documents: { "openapi/v1.json": document({ id: "requests.get", level: "stable" }, { id: "contract.report", level: "stable", method: "post", path: "/api/v1/contract-reports" }) },
    changelog: changelog([], [FIRST]),
    today: TODAY,
    ...overrides,
  };
}

describe("the graduation check", () => {
  it("exempts contract.report, which the CI OIDC path calls and which is stable from the start", () => {
    expect(STABLE_FROM_THE_START).toEqual(["contract.report"]);
    const onlyExempt = { "openapi/v1.json": document({ id: "requests.get", level: "beta" }, { id: "contract.report", level: "stable", method: "post", path: "/api/v1/contract-reports" }) };
    expect(graduationProblems(input({ documents: onlyExempt, changelog: changelog([]) }))).toEqual([]);
  });

  it("fails a stable operation whose graduation the changelog does not record: four quiet weeks alone do not graduate it", () => {
    expect(graduationProblems(input())).toEqual([
      "requests.get is stable in openapi/v1.json (GET /api/v1/requests/get), but openapi/changelog.json records no decision of the maintainers to graduate it. " +
        "An operation becomes stable only once no breaking change to it was needed for four weeks and the maintainers record their decision in an entry of kind graduation that names it.",
    ]);
  });

  it("passes a stable operation whose recorded graduation came four weeks after the release that offered it, with no breaking change since", () => {
    expect(QUIET_DAYS).toBe(28);
    expect(graduationProblems(input({ changelog: changelog([graduation("2026-02-10", "requests.get")], [FIRST]) }))).toEqual([]);
    // Once released, the graduation still passes.
    expect(graduationProblems(input({ changelog: changelog([], [release("1.1.0", "2026-02-12", [graduation("2026-02-10", "requests.get")]), FIRST]) }))).toEqual([]);
  });

  it("fails a graduation decided two weeks after a breaking change to the operation was released", () => {
    const releases = [release("1.1.0", "2026-01-27", [], [broken("requests.get")]), FIRST];
    expect(graduationProblems(input({ changelog: changelog([graduation("2026-02-10", "requests.get")], releases) }))).toEqual([
      "requests.get is stable in openapi/v1.json (GET /api/v1/requests/get), but its graduation of 2026-02-10, not released yet, does not pass the test: " +
        "a breaking change to it was released in 1.1.0 on 2026-01-27, 14 days before the decision, and the test needs four weeks (28 days) with no breaking change.",
    ]);
    // A breaking change the maintainers announced counts the same, from the day its release came out.
    const announced = [release("1.1.0", "2026-01-27", [breakingEntry("2026-01-20", "requests.get")]), FIRST];
    expect(graduationProblems(input({ changelog: changelog([graduation("2026-02-10", "requests.get")], announced) }))).toEqual([
      expect.stringContaining("a breaking change to it was released in 1.1.0 on 2026-01-27, 14 days before the decision"),
    ]);
  });

  it("counts four whole weeks: a breaking change 28 days before the decision passes, and one 27 days before fails", () => {
    const at = (date: string) => changelog([graduation("2026-02-10", "requests.get")], [release("1.1.0", date, [], [broken("requests.get")]), FIRST]);
    expect(graduationProblems(input({ changelog: at("2026-01-13") }))).toEqual([]);
    expect(graduationProblems(input({ changelog: at("2026-01-14") }))).toEqual([expect.stringContaining("27 days before the decision")]);
  });

  it("fails a breaking change released together with the graduation, in the same release or both not released yet", () => {
    const together = changelog([], [release("1.1.0", "2026-02-12", [graduation("2026-02-10", "requests.get")], [broken("requests.get")]), FIRST]);
    expect(graduationProblems(input({ changelog: together }))).toEqual([expect.stringContaining("a breaking change to it is released together with the graduation, in 1.1.0")]);
    const pending = changelog([graduation("2026-02-10", "requests.get"), breakingEntry("2026-02-20", "requests.get")], [FIRST]);
    expect(graduationProblems(input({ changelog: pending }))).toEqual([
      expect.stringContaining("a breaking change to it is not released yet, so it would be released together with the graduation"),
    ]);
  });

  it("leaves breaking changes released after the graduation to the notice rules of a stable operation", () => {
    const later = changelog(
      [breakingEntry("2026-02-25", "requests.get")],
      [release("1.2.0", "2026-02-20", [], [broken("requests.get")]), release("1.1.0", "2026-02-12", [graduation("2026-02-10", "requests.get")]), FIRST],
    );
    expect(graduationProblems(input({ changelog: later }))).toEqual([]);
  });

  it("fails a graduation dated after today, which no decision can be", () => {
    expect(graduationProblems(input({ changelog: changelog([graduation("2026-03-02", "requests.get")], [FIRST]) }))).toEqual([
      expect.stringContaining("its graduation of 2026-03-02, not released yet, does not pass the test: it is dated after today, 2026-03-01"),
    ]);
  });

  it("fails an operation no release offered at least four weeks before the decision", () => {
    expect(graduationProblems(input({ changelog: changelog([graduation("2026-02-10", "requests.get")]) }))).toEqual([
      expect.stringContaining("no release has offered it yet, so it has not had four weeks (28 days) with no breaking change"),
    ]);
    const recent = changelog([graduation("2026-02-10", "requests.get")], [release("1.1.0", "2026-02-01", [], [added("requests.get")]), release("1.0.0", "2026-01-05", [], [added("contract.report")])]);
    expect(graduationProblems(input({ changelog: recent }))).toEqual([
      expect.stringContaining("the release that offered it, 1.1.0 on 2026-02-01, came 9 days before the decision, and the test needs four weeks (28 days)"),
    ]);
    // Added and graduated in one release is no four weeks either.
    const atOnce = changelog([], [release("1.1.0", "2026-02-12", [graduation("2026-02-10", "requests.get")], [added("requests.get")]), release("1.0.0", "2026-01-05")]);
    expect(graduationProblems(input({ changelog: atOnce }))).toEqual([expect.stringContaining("no release before the graduation offered it")]);
  });

  it("passes when any recorded graduation passes, and otherwise reports the latest one", () => {
    const releases = [release("1.1.0", "2026-01-27", [], [broken("requests.get")]), FIRST];
    const early = graduation("2026-02-01", "requests.get");
    expect(graduationProblems(input({ changelog: changelog([early, graduation("2026-02-24", "requests.get")], releases) }))).toEqual([]);
    expect(graduationProblems(input({ changelog: changelog([early, graduation("2026-02-10", "requests.get")], releases) }))).toEqual([
      expect.stringContaining("its graduation of 2026-02-10"),
    ]);
  });

  it("reads the document of every major version", () => {
    const documents = { "openapi/v1.json": document({ id: "requests.get", level: "beta" }), "openapi/v2.json": document({ id: "requests.list", level: "stable", path: "/api/v2/requests" }) };
    expect(graduationProblems(input({ documents, changelog: changelog([]) }))).toEqual([expect.stringMatching(/^requests\.list is stable in openapi\/v2\.json \(GET \/api\/v2\/requests\), but openapi\/changelog\.json records no decision/)]);
  });

  it("reads the stable tools of the snapshot by their operation, also one offered only on MCP", () => {
    const documents = { "openapi/v1.json": document({ id: "requests.get", level: "stable" }) };
    const snapshot = tools({ name: "get_request", operationId: "requests.get", stability: "stable" }, { name: "directory", operationId: "directory.get", stability: "stable" });
    expect(graduationProblems(input({ documents, tools: snapshot, changelog: changelog([], [FIRST]) }))).toEqual([
      expect.stringMatching(/^directory\.get is stable in mcp\/tools\.json \(the tool directory\), but openapi\/changelog\.json records no decision/),
      expect.stringMatching(/^requests\.get is stable in openapi\/v1\.json \(GET \/api\/v1\/requests\/get\) and mcp\/tools\.json \(the tool get_request\), but openapi\/changelog\.json records no decision/),
    ]);
    // The release records list the changes of openapi/v1.json, so for an operation offered only on MCP the
    // check reads the maintainers' entries alone.
    const graduated = changelog([graduation("2026-02-10", "requests.get", "directory.get")], [FIRST]);
    expect(graduationProblems(input({ documents, tools: snapshot, changelog: graduated }))).toEqual([]);
    const announced = changelog([graduation("2026-02-10", "requests.get", "directory.get")], [release("1.1.0", "2026-02-01", [breakingEntry("2026-01-30", "directory.get")]), FIRST]);
    expect(graduationProblems(input({ documents, tools: snapshot, changelog: announced }))).toEqual([
      expect.stringContaining("directory.get is stable in mcp/tools.json (the tool directory), but its graduation of 2026-02-10, not released yet, does not pass the test: a breaking change to it was released in 1.1.0"),
    ]);
  });

  it("fails a stable tool whose snapshot records no operation, and a changelog that does not parse", () => {
    expect(graduationProblems(input({ tools: tools({ name: "directory", stability: "stable" }), changelog: changelog([graduation("2026-02-10", "requests.get")], [FIRST]) }))).toEqual([
      "mcp/tools.json: the tool directory is stable but names no operation, so its graduation cannot be checked; run `pnpm mcp:generate`.",
    ]);
    expect(graduationProblems(input({ changelog: "{" }))).toEqual([expect.stringContaining("openapi/changelog.json does not parse")]);
  });

  it("passes on the real tree, where only contract.report is stable", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(graduationProblems({ ...readGraduationTree(repoRoot), today })).toEqual([]);
  });
});

describe("the graduation script", { timeout: 60_000 }, () => {
  function check(root: string) {
    const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    if (run.error) throw run.error;
    return run;
  }

  it("fails a fixture tree with a stable operation the changelog does not graduate", () => {
    const run = check(fixture("ungraduated"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("requests.get is stable in openapi/v1.json (GET /api/v1/requests/{key}), but openapi/changelog.json records no decision of the maintainers to graduate it.");
  });

  it("fails a fixture tree whose graduation came two weeks after a breaking change", () => {
    const run = check(fixture("recent-break"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("a breaking change to it was released in 1.1.0 on 2026-01-27, 14 days before the decision");
  });

  it("passes a fixture tree whose graduation passed the test", () => {
    const run = check(fixture("graduated"));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Every stable operation of the OpenAPI documents and mcp/tools.json has passed the graduation test, or is contract.report");
  });

  it("passes on the real tree", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

describe("CI's run of the graduation check", () => {
  it("runs it on every pull request and push to main, with the packages it reads installed", () => {
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    const running = Object.values(workflow.jobs).filter(({ steps }) => (steps ?? []).some(({ run }) => run === "pnpm check:graduation"));
    expect(running).toHaveLength(1);
    const runs = (running[0]?.steps ?? []).map(({ run }) => run ?? "");
    const install = runs.findIndex((run) => run.startsWith("pnpm install --frozen-lockfile") && run.includes("--filter @tiehall/repo-checks"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(runs.indexOf("pnpm check:graduation"));
  });
});
