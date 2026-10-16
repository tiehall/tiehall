import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findContentsCalls, findReaderDependencies, loadReaderDenylist, serverPackages, WORKSPACE_FOLDERS } from "../src/spec-reading.ts";

// Nothing on the server reads OpenAPI documents (contract-changes: Contract
// diffs run only where the specs already are; design.md, Design rules:
// Contract changes; design.md, Technical decisions: T12). The CI check fails
// when a server package depends on an OpenAPI parser or diff tool, or when its
// code calls one of GitHub's endpoints that read a repository's files. It runs
// the same script as the CI job against committed fixtures and the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-spec-reading.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/spec-reading/${name}/`, import.meta.url));

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

describe("the server packages", () => {
  it("are the apps the image runs and every workspace package they depend on, and no tool, CLI or Action", () => {
    expect(serverPackages(repoRoot).map(({ folder }) => folder)).toEqual([
      "apps/server",
      "apps/web",
      "packages/catalog",
      "packages/commands",
      "packages/core",
      "packages/db",
      "packages/packet",
    ]);
  });
});

/** The folders a pnpm-workspace.yaml's text makes workspace packages of, as its packages list writes them, without the ones it leaves out. */
function workspaceGlobs(workspace: string): string[] {
  const { packages } = parse(workspace) as { packages?: unknown };
  return Array.isArray(packages) ? packages.map(String).filter((glob) => !glob.startsWith("!")) : [];
}

describe("the workspace packages", () => {
  it("are found one folder deep in each folder pnpm-workspace.yaml makes workspace packages of, and nowhere else", () => {
    const listed = workspaceGlobs(readFileSync(new URL("pnpm-workspace.yaml", `file://${repoRoot}`), "utf8"));
    expect(listed).toEqual(WORKSPACE_FOLDERS.map((folder) => `${folder}/*`));
  });

  it("are read from the packages list only, not from the other lists of pnpm-workspace.yaml, such as its exclusions from the release age", () => {
    const workspace = [
      "packages:",
      "  - apps/*",
      "  - packages/*",
      '  - "!spikes/**"',
      "minimumReleaseAge: 10080",
      "minimumReleaseAgeExclude:",
      '  - "undici@7.16.1"',
      "",
    ].join("\n");
    expect(workspaceGlobs(workspace)).toEqual(["apps/*", "packages/*"]);
  });

  it("leave out a package kept outside those folders, even one a server app names", () => {
    const root = fixture("outside-workspace");
    expect(serverPackages(root).map(({ folder }) => folder)).toEqual(["apps/server"]);
    expect(findReaderDependencies(root, loadReaderDenylist())).toEqual([]);
    expect(findContentsCalls(root)).toEqual([]);
    expect(check(root).status).toBe(0);
  });
});

describe("the check that no server package depends on an OpenAPI parser or diff tool", () => {
  it("fails on a server package that depends on one, directly or through a workspace package, also under an npm alias", () => {
    const run = check(fixture("with-reader"));
    expect(run.status).toBe(1);
    expect(findReaderDependencies(fixture("with-reader"), loadReaderDenylist())).toEqual([
      {
        file: "packages/catalog/package.json",
        field: "dependencies",
        name: "@apidevtools/swagger-parser",
        as: "@apidevtools/swagger-parser",
        listedAs: "@apidevtools/swagger-parser",
      },
      { file: "packages/lib/package.json", field: "devDependencies", name: "@useoptic/openapi-utilities", as: "differ", listedAs: "@useoptic" },
    ]);
  });

  it("passes a developer tool that depends on one, since it never runs on the server", () => {
    expect(findReaderDependencies(fixture("clean"), loadReaderDenylist())).toEqual([]);
  });
});

describe("the check that no server code reads a repository's files on GitHub", () => {
  it("fails on a call to the contents endpoint, Octokit's getContent and GitHub's raw file host", () => {
    const run = check(fixture("with-contents-call"));
    expect(run.status).toBe(1);
    expect(findContentsCalls(fixture("with-contents-call")).map(({ file, reads }) => `${file}: ${reads}`)).toEqual([
      "packages/commands/src/raw.ts: GitHub's raw file host",
      "packages/commands/src/rest.ts: Octokit's method for a repository's files",
      "packages/commands/src/rest.ts: Octokit's method for a repository's files",
      "packages/commands/src/specs.ts: a repository's contents or readme endpoint",
    ]);
  });

  it("passes the pull request and installation calls the server makes, a test that names a contents URL, and a developer tool", () => {
    expect(check(fixture("clean")).status).toBe(0);
    expect(findContentsCalls(fixture("clean"))).toEqual([]);
  });
});

describe("the real tree", () => {
  it("passes both checks", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
