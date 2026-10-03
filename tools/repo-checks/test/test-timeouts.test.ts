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

/**
 * The workspace's packages: every package directly under apps, packages,
 * actions and tools. They are the Vitest projects the root vitest.config.ts
 * lists, and tools/image-tests, which `pnpm test:image` runs on its own. The
 * pathspecs are globs whose `*` stays within one folder, so the package.json
 * files of the tests' fixtures, deeper down, are not packages.
 */
function projects(): string[] {
  const packages = ["apps", "packages", "actions", "tools"].map((folder) => `:(glob)${folder}/*/package.json`);
  const files = execFileSync("git", ["ls-files", ...packages], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return files
    .split("\n")
    .filter((file) => file !== "")
    .map((file) => file.slice(0, -"/package.json".length));
}

/** The TypeScript sources of a project's tests, committed or new and not ignored, fixtures left out. */
function testSources(project: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", `${project}/test`], { cwd: repoRoot, encoding: "utf8" })
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

/**
 * The waits a test source fixes, in milliseconds, each with its line: a wait
 * helper's default, such as `seconds = 20`; a deadline a loop polls against,
 * such as `const until = Date.now() + 10_000;`; and a browser locator's
 * `waitFor({ timeout })`.
 */
function fixedWaits(source: string): { line: number; ms: number }[] {
  const waits: { line: number; ms: number }[] = [];
  const number = (text: string) => Number(text.replaceAll("_", ""));
  source.split("\n").forEach((text, index) => {
    for (const [, value = ""] of text.matchAll(/\bseconds\s*=\s*(\d[\d_]*)\b/g)) waits.push({ line: index + 1, ms: number(value) * 1000 });
    for (const [, value = ""] of text.matchAll(/\b(?:const|let)\s+\w+\s*=\s*Date\.now\(\)\s*\+\s*(\d[\d_]*)\s*;/g)) waits.push({ line: index + 1, ms: number(value) });
    for (const [, value = ""] of text.matchAll(/\.waitFor\(\{\s*timeout:\s*(\d[\d_]*)\s*\}\)/g)) waits.push({ line: index + 1, ms: number(value) });
  });
  return waits;
}

/** A timeout the config sets, in milliseconds, or undefined when it sets none. */
function timeoutIn(config: string, name: "testTimeout" | "hookTimeout"): number | undefined {
  const match = new RegExp(`\\b${name}:\\s*([\\d_]+)`).exec(config);
  return match === null ? undefined : Number(match[1]!.replaceAll("_", ""));
}

describe("the workspace's packages the check reads", () => {
  it("are the packages under apps, packages, actions and tools, without the package.json files of the tests' fixtures", () => {
    const found = projects();
    expect(found).toEqual(expect.arrayContaining(["apps/server", "packages/commands", "actions/contract", "tools/repo-checks", "tools/image-tests"]));
    expect(found.filter((project) => project.split("/").length !== 2)).toEqual([]);
  });
});

describe("the Vitest projects whose tests start browsers, child processes or containers", () => {
  it("are found: the ones with the Postgres container, the browsers and the repository's checks", () => {
    const found = projects().filter(startsProcesses);
    expect(found).toEqual(expect.arrayContaining(["apps/server", "apps/web", "packages/commands", "packages/db", "tools/repo-checks"]));
    expect(found).not.toContain("packages/core");
  });

  // A wait that holds on a laptop ran out on CI's runners: the web role's
  // tests waited 20 seconds for the role to listen, which a loaded runner
  // took longer than twice. So a wait a test fixes is at least as long as the
  // shortest test timeout, 30 seconds.
  it("fix no wait shorter than 30 seconds in their tests", () => {
    expect(fixedWaits(["async function until(what: string, seconds = 20) {", "  const until = Date.now() + 5_000;", "await page.waitFor({ timeout: 20_000 });", "new Date(Date.now() + 600_000)"].join("\n"))).toEqual([
      { line: 1, ms: 20_000 },
      { line: 2, ms: 5_000 },
      { line: 3, ms: 20_000 },
    ]);
    const problems = projects()
      .filter(startsProcesses)
      .flatMap((project) => testSources(project))
      .filter((file) => file !== "tools/repo-checks/test/test-timeouts.test.ts")
      .flatMap((file) =>
        fixedWaits(readFileSync(join(repoRoot, file), "utf8"))
          .filter(({ ms }) => ms < 30_000)
          .map(({ line, ms }) => `${file}:${line} waits ${ms} ms`),
      );
    expect(problems).toEqual([]);
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
