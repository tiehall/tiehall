import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findModelSdkDependencies, loadDenylist, loadTelemetryDenylist, type Denylist } from "../src/model-sdks.ts";

// The CI check for self-host-install: No model calls, extended to
// self-host-install: No telemetry and a documented list of outbound
// connections. No workspace package.json may depend on a model-vendor SDK, or
// on an analytics SDK, an error-reporting SDK or an update checker. It runs
// the same script as the CI job against committed fixtures and the real tree.

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

  it("fails on a workspace that depends on an analytics SDK, an error-reporting SDK or an update checker", () => {
    const run = check(fixture("with-telemetry-sdks"));
    expect(run.status).toBe(1);
    expect(findModelSdkDependencies(fixture("with-telemetry-sdks"), loadTelemetryDenylist())).toEqual([
      { file: "apps/web/package.json", field: "dependencies", name: "@sentry/nextjs", as: "@sentry/nextjs", listedAs: "@sentry" },
      { file: "package.json", field: "dependencies", name: "posthog-node", as: "posthog-node", listedAs: "posthog-node" },
      { file: "packages/cli/package.json", field: "dependencies", name: "update-notifier", as: "update-notifier", listedAs: "update-notifier" },
    ]);
    expect(run.stderr).toContain(
      "apps/web/package.json: dependencies has @sentry/nextjs, which the telemetry denylist names as @sentry (Sentry error reporting).",
    );
    expect(run.stderr).toContain("An install sends nothing to the Tiehall project or to any service it runs (S13)");
    expect(run.stderr).not.toContain("model SDK denylist");
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

  it.each([
    ["model", loadDenylist()],
    ["telemetry", loadTelemetryDenylist()],
  ] as [string, Denylist][])("keeps a well-formed %s denylist of package names and scopes", (_, denylist) => {
    expect(Object.keys(denylist.scopes).length).toBeGreaterThan(0);
    expect(Object.keys(denylist.packages).length).toBeGreaterThan(0);
    for (const scope of Object.keys(denylist.scopes)) expect(scope).toMatch(/^@[a-z0-9][a-z0-9._-]*$/);
    for (const name of Object.keys(denylist.packages)) expect(name).toMatch(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
  });

  it("leaves the MCP SDK and OpenTelemetry's API off the lists, since neither calls anyone by itself", () => {
    const raw = readFileSync(fileURLToPath(new URL("../model-sdk-denylist.json", import.meta.url)), "utf8");
    expect(raw).not.toMatch(/"@modelcontextprotocol/);
    const telemetry = readFileSync(fileURLToPath(new URL("../telemetry-sdk-denylist.json", import.meta.url)), "utf8");
    expect(telemetry).not.toMatch(/"@opentelemetry/);
  });
});
