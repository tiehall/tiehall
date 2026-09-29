import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Timeouts that hold on a CI runner (design.md, Technical decisions: T17).
// A test that starts a browser, a child process or a container takes longer
// on GitHub's runners than on a laptop: a browser test's hook ran out of
// Vitest's 10-second default for hooks there, and a Compose check that runs
// `docker compose config` twice took 3.7 of Vitest's 5 seconds for a test.
// So every Vitest project whose tests start one gives its tests at least 30
// seconds and its hooks at least 60 in its own vitest.config.ts; a test or
// hook that needs more gives its own timeout.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** What a test source imports to start a child process, a browser or a container. */
const STARTS_PROCESSES = /from\s+"(?:node:child_process|playwright-core|testcontainers)"/;

/** The Vitest projects of the workspace, as the root vitest.config.ts lists them: every package under apps, packages, actions and tools. */
function projects(): string[] {
  const files = execFileSync("git", ["ls-files", "apps/*/package.json", "packages/*/package.json", "actions/*/package.json", "tools/*/package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return files
    .split("\n")
    .filter((file) => file !== "")
    .map((file) => file.slice(0, -"/package.json".length));
}

/** The committed TypeScript sources of a project's tests, fixtures left out. */
function testSources(project: string): string[] {
  return execFileSync("git", ["ls-files", `${project}/test`], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".ts") && !file.includes("/fixtures/"));
}

/** The project's vitest.config.ts, or undefined when it has none. */
function configOf(project: string): string | undefined {
  const path = join(repoRoot, project, "vitest.config.ts");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Whether the project's tests start a child process, a browser or a container, the Postgres container of its global setup included. */
function startsProcesses(project: string): boolean {
  if (configOf(project)?.includes("globalSetup") === true) return true;
  return testSources(project).some((file) => STARTS_PROCESSES.test(readFileSync(join(repoRoot, file), "utf8")));
}

/** A timeout the config sets, in milliseconds, or undefined when it sets none. */
function timeoutIn(config: string, name: "testTimeout" | "hookTimeout"): number | undefined {
  const match = new RegExp(`\\b${name}:\\s*([\\d_]+)`).exec(config);
  return match === null ? undefined : Number(match[1]!.replaceAll("_", ""));
}

describe("the Vitest projects whose tests start browsers, child processes or containers", () => {
  it("are found: the ones with the Postgres container, the browsers and the repository's checks", () => {
    const found = projects().filter(startsProcesses);
    expect(found).toEqual(expect.arrayContaining(["apps/server", "apps/web", "packages/commands", "packages/db", "tools/repo-checks"]));
    expect(found).not.toContain("packages/core");
  });

  it("each give their tests at least 30 seconds and their hooks at least 60, in their own vitest.config.ts", () => {
    const problems: string[] = [];
    for (const project of projects().filter(startsProcesses)) {
      const config = configOf(project);
      if (config === undefined) {
        problems.push(`${project} has no vitest.config.ts`);
        continue;
      }
      const tests = timeoutIn(config, "testTimeout");
      const hooks = timeoutIn(config, "hookTimeout");
      if (tests === undefined || tests < 30_000) problems.push(`${project} gives its tests ${tests ?? "Vitest's default of 5000"} ms`);
      if (hooks === undefined || hooks < 60_000) problems.push(`${project} gives its hooks ${hooks ?? "Vitest's default of 10000"} ms`);
    }
    expect(problems).toEqual([]);
  });
});
