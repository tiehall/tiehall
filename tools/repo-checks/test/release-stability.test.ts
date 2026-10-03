import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseStabilityProblems } from "../src/release-stability.ts";

// The release check of stability levels (public-api: Each operation carries
// a stability level; design.md, Design rules: Public API). A published
// release offers no operation or MCP tool at alpha: the release job runs this
// check on the release's committed documents, every openapi/v<N>.json and
// mcp/tools.json, and stops when it finds an operation or a tool at alpha, or
// an operation without a stability level, before anything is published
// (task 29.3 gates the release on it). Between releases alpha is allowed, so
// the check does not run on every pull request. It runs the same script as the
// release job, `pnpm release:check-stability`, against fixture releases and
// the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-release-stability.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/release-stability/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the release check of stability levels", () => {
  it("passes a release whose every operation and tool is beta or stable", () => {
    expect(releaseStabilityProblems(fixture("clean"))).toEqual([]);
    const run = check(fixture("clean"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No operation of openapi/v1.json and no tool of mcp/tools.json is at alpha");
  });

  it("refuses a release with an operation at alpha, and one with an operation that carries no level", () => {
    expect(releaseStabilityProblems(fixture("with-alpha-operation"))).toEqual([
      "openapi/v1.json: POST /api/v1/requests (requests.create) is at alpha, and a release offers no operation at alpha.",
      "openapi/v1.json: GET /api/v1/requests/{key} (requests.get) carries no stability level.",
    ]);
    const run = check(fixture("with-alpha-operation"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("POST /api/v1/requests (requests.create) is at alpha");
    expect(run.stderr).toContain("Move it to beta, or leave it out of the release");
  });

  it("refuses a release with a tool at alpha", () => {
    expect(releaseStabilityProblems(fixture("with-alpha-tool"))).toEqual(["mcp/tools.json: the tool open_request is at alpha, and a release offers no tool at alpha."]);
    expect(check(fixture("with-alpha-tool")).status).toBe(1);
  });

  it("reads the document of every major version the release serves", () => {
    expect(releaseStabilityProblems(fixture("with-alpha-in-v2"))).toEqual([
      "openapi/v2.json: POST /api/v2/requests (requests.create) is at alpha, and a release offers no operation at alpha.",
    ]);
  });

  it("refuses a release that has no OpenAPI document or no tool list to check", () => {
    expect(releaseStabilityProblems(fixture("missing"))).toEqual(["The release holds no openapi/v1.json.", "The release holds no mcp/tools.json."]);
  });

  it("passes on the real tree, whose operations and tools are all beta or stable", () => {
    expect(releaseStabilityProblems(repoRoot)).toEqual([]);
    expect(check(repoRoot).status).toBe(0);
  });
});
