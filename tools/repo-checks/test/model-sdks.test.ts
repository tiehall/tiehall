import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { denylistReason, findLockfilePackages, findModelSdkDependencies, lockfilePackages, loadDenylist, loadTelemetryDenylist, type Denylist } from "../src/model-sdks.ts";

// The CI check for self-host-install: No model calls, extended to
// self-host-install: No telemetry and a documented list of outbound
// connections. No workspace package.json may depend on a model-vendor SDK, or
// on an analytics SDK, an error-reporting SDK or an update checker, and the
// lockfile may resolve none of them, whatever depends on it. It runs the same
// script as the CI job against committed fixtures and the real tree. The
// built image's own check is in tools/image-tests (image.test.ts).

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

  it("fails on a lockfile that resolves model-vendor and telemetry SDKs that no package.json names, in either of its documents", () => {
    const root = fixture("lockfile-with-sdks");
    expect(findModelSdkDependencies(root, loadDenylist())).toEqual([]);
    expect(findLockfilePackages(root, loadDenylist())).toEqual([
      { file: "pnpm-lock.yaml", name: "@anthropic-ai/sdk", version: "0.60.0", listedAs: "@anthropic-ai" },
      { file: "pnpm-lock.yaml", name: "openai", version: "5.10.0", listedAs: "openai" },
    ]);
    expect(findLockfilePackages(root, loadTelemetryDenylist())).toEqual([{ file: "pnpm-lock.yaml", name: "@sentry/node", version: "9.0.0", listedAs: "@sentry" }]);
    const run = check(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("pnpm-lock.yaml: resolves openai@5.10.0, which the model SDK denylist names as openai.");
    expect(run.stderr).toContain("pnpm-lock.yaml: resolves @anthropic-ai/sdk@0.60.0, which the model SDK denylist names as @anthropic-ai.");
    expect(run.stderr).toContain("pnpm-lock.yaml: resolves @sentry/node@9.0.0, which the telemetry denylist names as @sentry (Sentry error reporting).");
  });

  it("reads every package a lockfile resolves, by name and version, from its packages and snapshots, peers left out", () => {
    const text = readFileSync(`${fixture("lockfile-with-sdks")}pnpm-lock.yaml`, "utf8");
    expect(lockfilePackages(text)).toEqual([
      { name: "@anthropic-ai/sdk", version: "0.60.0" },
      { name: "@sentry/node", version: "9.0.0" },
      { name: "chat-helpers", version: "1.0.0" },
      { name: "openai", version: "5.10.0" },
      { name: "pnpm", version: "12.6.0" },
      { name: "zod", version: "4.1.0" },
    ]);
  });

  it("passes on a lockfile that resolves look-alike names only", () => {
    expect(findLockfilePackages(fixture("clean"), loadDenylist())).toEqual([]);
    expect(findLockfilePackages(fixture("clean"), loadTelemetryDenylist())).toEqual([]);
  });

  it("reads the real lockfile, and finds no denied package in it", () => {
    const text = readFileSync(`${repoRoot}pnpm-lock.yaml`, "utf8");
    const names = lockfilePackages(text).map(({ name }) => name);
    for (const name of ["next", "better-auth", "pg", "zod", "@modelcontextprotocol/server"]) expect(names).toContain(name);
    expect(findLockfilePackages(repoRoot, loadDenylist())).toEqual([]);
    expect(findLockfilePackages(repoRoot, loadTelemetryDenylist())).toEqual([]);
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

  // IBM's font packages, @ibm/plex-sans and @ibm/plex-mono, run IBM's telemetry tool when they are installed, so the
  // repository keeps their font files instead (web-ui: Fonts served by the install; design.md, Design: Type and the
  // self-hosted fonts; D57 (3)); the denylist names the tool, so no later change brings it into the lockfile unnoticed.
  it("names IBM's telemetry tool, which IBM's font packages install, and the lockfile resolves no package of IBM's", () => {
    expect(denylistReason(loadTelemetryDenylist(), "@ibm/telemetry-js")).toMatch(/telemetry/i);
    const text = readFileSync(`${repoRoot}pnpm-lock.yaml`, "utf8");
    expect(lockfilePackages(text).filter(({ name }) => name.startsWith("@ibm/"))).toEqual([]);
  });

  it("leaves the MCP SDK and OpenTelemetry's API off the lists, since neither calls anyone by itself", () => {
    const raw = readFileSync(fileURLToPath(new URL("../model-sdk-denylist.json", import.meta.url)), "utf8");
    expect(raw).not.toMatch(/"@modelcontextprotocol/);
    const telemetry = readFileSync(fileURLToPath(new URL("../telemetry-sdk-denylist.json", import.meta.url)), "utf8");
    expect(telemetry).not.toMatch(/"@opentelemetry/);
  });
});
