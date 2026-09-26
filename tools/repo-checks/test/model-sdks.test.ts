import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findModelSdkDependencies, loadDenylist } from "../src/model-sdks.ts";

// The CI check for self-host-install: No model calls. It runs the same script
// as the CI job against committed fixtures and the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-model-sdks.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/model-sdks/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the model SDK check", () => {
  it("fails on a workspace that depends on model-vendor SDKs, in any dependency field or through an npm alias", () => {
    const run = check(fixture("with-model-sdks"));
    expect(run.status).toBe(1);
    for (const name of ["@anthropic-ai/sdk", "openai", "@google/genai", "@mistralai/mistralai"]) {
      expect(run.stderr).toContain(name);
    }

    expect(findModelSdkDependencies(fixture("with-model-sdks"), loadDenylist())).toEqual([
      { file: "apps/web/package.json", field: "dependencies", name: "openai", as: "openai", listedAs: "openai" },
      {
        file: "package.json",
        field: "devDependencies",
        name: "@anthropic-ai/sdk",
        as: "@anthropic-ai/sdk",
        listedAs: "@anthropic-ai",
      },
      {
        file: "packages/cli/package.json",
        field: "optionalDependencies",
        name: "@mistralai/mistralai",
        as: "chat",
        listedAs: "@mistralai",
      },
      {
        file: "packages/core/package.json",
        field: "peerDependencies",
        name: "@google/genai",
        as: "@google/genai",
        listedAs: "@google/genai",
      },
    ]);
  });

  it("passes on a workspace with look-alike names that are not model SDKs", () => {
    const run = check(fixture("clean"));
    expect(run.stderr).not.toContain("denylist");
    expect(run.stdout).toContain("No LLM or model-vendor SDK");
    expect(run.status).toBe(0);
  });

  it("passes on the real tree", () => {
    const run = check(repoRoot);
    expect(run.stderr).not.toContain("denylist");
    expect(run.stdout).toContain("No LLM or model-vendor SDK");
    expect(run.status).toBe(0);
  });

  it("keeps a well-formed denylist of package names and scopes", () => {
    const denylist = loadDenylist();
    expect(Object.keys(denylist.scopes).length).toBeGreaterThan(0);
    expect(Object.keys(denylist.packages).length).toBeGreaterThan(0);
    for (const scope of Object.keys(denylist.scopes)) expect(scope).toMatch(/^@[a-z0-9][a-z0-9._-]*$/);
    for (const name of Object.keys(denylist.packages)) expect(name).toMatch(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
    const raw = readFileSync(fileURLToPath(new URL("../model-sdk-denylist.json", import.meta.url)), "utf8");
    expect(raw).not.toMatch(/"@modelcontextprotocol/);
  });
});
