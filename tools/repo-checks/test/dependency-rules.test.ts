import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the same dependency-cruiser command as CI (`pnpm lint:deps`), with the
// repo's real config, against committed fixture trees that mirror the repo
// layout, and against the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const config = fileURLToPath(new URL("../../../.dependency-cruiser.cjs", import.meta.url));
const depcruise = fileURLToPath(new URL("../node_modules/.bin/depcruise", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/dependency-rules/${name}/`, import.meta.url));

interface Violation {
  from: string;
  to: string;
  rule: { name: string; severity: string };
}

interface CruiseResult {
  /** The exit code of the check as CI runs it, with the default `err` reporter. */
  exitCode: number | null;
  modules: string[];
  violations: Violation[];
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(depcruise, ["--config", config, ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function cruise(cwd: string, targets: string[]): CruiseResult {
  const check = run(cwd, targets);
  const json = run(cwd, ["--output-type", "json", ...targets]);
  if (!json.stdout) throw new Error(`dependency-cruiser printed nothing: ${json.stderr}`);
  const result = JSON.parse(json.stdout) as {
    modules: { source: string }[];
    summary: { violations: Violation[] };
  };
  return {
    exitCode: check.status,
    modules: result.modules.map((module) => module.source),
    violations: result.summary.violations,
  };
}

function violationsOf(result: CruiseResult, rule: string): string[] {
  return result.violations
    .filter((violation) => violation.rule.name === rule)
    .map((violation) => violation.from)
    .sort();
}

describe("the dependency rules", { timeout: 60_000 }, () => {
  it("refuse an import from apps/web into packages/db, by name, by path or for types only", () => {
    const result = cruise(fixture("web-imports-db"), ["apps", "packages"]);
    expect(violationsOf(result, "db-only-from-commands-and-migrations")).toEqual([
      "apps/web/app/by-name.ts",
      "apps/web/app/by-path.ts",
      "apps/web/app/type-only.ts",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuse a network, database, queue or I/O-package import in packages/core", () => {
    const result = cruise(fixture("core-imports-io"), ["packages"]);
    expect(violationsOf(result, "core-does-no-io")).toEqual([
      "packages/core/src/commands.ts",
      "packages/core/src/database.ts",
      "packages/core/src/fetcher.ts",
      "packages/core/src/network.ts",
      "packages/core/src/queue.ts",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuse database code in packages/catalog", () => {
    const result = cruise(fixture("catalog-imports-db"), ["packages"]);
    expect(violationsOf(result, "catalog-holds-no-database-code")).toEqual([
      "packages/catalog/src/index.ts",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuse a client-side import of anything but the catalog's public entry point", () => {
    const result = cruise(fixture("client-imports-server"), ["packages", "actions"]);
    expect(violationsOf(result, "client-side-imports-only-the-public-catalog")).toEqual([
      "actions/contract/src/index.ts",
      "packages/cli/src/index.ts",
      "packages/client/src/index.ts",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  it("allow commands and the migrations to import packages/db, and the CLI to import the public catalog", () => {
    const result = cruise(fixture("allowed"), ["apps", "packages"]);
    expect(result.violations).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("pass on the real tree, which excludes the fixtures and the non-code folders", () => {
    const result = cruise(repoRoot, ["apps", "packages", "actions", "tools"]);
    expect(result.violations).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.modules).toContain("packages/db/src/index.ts");
    expect(result.modules).toContain("packages/catalog/src/public.ts");
    expect(result.modules.filter((path) => /(^|\/)(test\/fixtures|\.next|\.claude|spikes|openspec)\//.test(path))).toEqual([]);
  });
});
