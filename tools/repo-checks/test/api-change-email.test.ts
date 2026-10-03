import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryFiles } from "../src/source-citations.ts";

// No email about API changes (public-api: The changelog page and the release
// notes; D28 #28). Tiehall emails no token holder about API changes: the
// changelog page and the release notes are the notice. The check reads the
// real tree's imports with dependency-cruiser: no module reaches both the API
// changelog and the email adapter, so no code path can send the changelog by
// email; and no email template is about the API.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = fileURLToPath(new URL("../../../.dependency-cruiser.cjs", import.meta.url));
const depcruise = fileURLToPath(new URL("../node_modules/.bin/depcruise", import.meta.url));

/** The modules that hold or read the API changelog. */
const CHANGELOG_MODULES = /^packages\/catalog\/src\/(changelog|api-changelog)\.ts$/;
/** The modules that send email: the SMTP adapter and the library under it. */
const EMAIL_MODULES = /^packages\/commands\/src\/email\.ts$|(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?nodemailer\/|^nodemailer$/;

/** Every module of the tree with the modules it imports, directly. */
function importGraph(): Map<string, string[]> {
  const run = spawnSync(depcruise, ["--config", config, "--output-type", "json", "apps", "packages", "actions", "tools"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const { modules } = JSON.parse(run.stdout) as { modules: { source: string; dependencies: { resolved: string }[] }[] };
  return new Map(modules.map(({ source, dependencies }) => [source, dependencies.map(({ resolved }) => resolved)]));
}

/** Every module a module reaches through its imports, itself included. */
function reach(graph: Map<string, string[]>, start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  for (const next of graph.get(start) ?? []) reach(graph, next, seen);
  return seen;
}

describe("email about API changes", { timeout: 60_000 }, () => {
  const graph = importGraph();

  it("reads the modules the check is about", () => {
    const modules = [...graph.keys()];
    expect(modules.filter((module) => CHANGELOG_MODULES.test(module)).sort()).toEqual([
      "packages/catalog/src/api-changelog.ts",
      "packages/catalog/src/changelog.ts",
    ]);
    expect(modules).toContain("packages/commands/src/email.ts");
    expect(modules).toContain("apps/web/app/docs/api/changelog/route.ts");
    expect(modules).toContain("tools/repo-checks/src/record-release.ts");
  });

  it("has no code path: no module reaches both the API changelog and the email adapter", () => {
    const both = [...graph.keys()].filter((module) => {
      const reached = [...reach(graph, module)];
      return reached.some((other) => CHANGELOG_MODULES.test(other)) && reached.some((other) => EMAIL_MODULES.test(other));
    });
    expect(both).toEqual([]);
  });

  it("has no email template about the API, its changelog, deprecations or sunsets", () => {
    const templates = repositoryFiles(root)
      .filter((file) => /^(apps|packages)\/.*\.tsx?$/.test(file) && !file.includes("/test/"))
      .flatMap((file) => [...readFileSync(`${root}${file}`, "utf8").matchAll(/EmailTemplate<[^>]*>\s*=\s*\{\s*id:\s*"([^"]+)"/g)].map(([, id]) => `${file}: ${id}`));
    expect(templates).toContain("packages/commands/src/email.ts: email.test_message");
    expect(templates.filter((template) => /api|changelog|deprecat|sunset|breaking/i.test(template.split(": ")[1] ?? ""))).toEqual([]);
  });
});
