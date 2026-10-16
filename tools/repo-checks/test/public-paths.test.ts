import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isPublic, loadPublicPaths, patternRegExp } from "../src/public-paths.ts";

// The allowlist of paths the public repository holds (task 30.1; design.md,
// Decisions this change rests on: D38). Every tracked file lies within the
// committed allowlist, tools/repo-checks/public-paths.json, and private/,
// where the planning material that stays out of the public repository lives
// (task 3.4), stays git-ignored by the repository's own .gitignore. With
// --history, the check reads every path that any commit of any ref holds, as
// the history rewrite of task 30.3 is checked. The tests run the same script
// as the CI job over scratch repositories whose files and history are built
// here, and over the real tree.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../src/check-public-paths.ts", import.meta.url));

function check(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [script, root, ...args], { encoding: "utf8" });
  if (run.error) throw run.error;
  return run;
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

function write(repo: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
}

/** The lines a run printed on its standard output, each a path outside the allowlist. */
const outside = (stdout: string) => stdout.split("\n").filter((line) => line !== "");

describe("the public-paths check", () => {
  let scratch: string;
  let count = 0;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-public-paths-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A scratch repository whose one commit holds the files given. */
  function repository(files: Record<string, string>): string {
    const repo = join(scratch, `repo-${++count}`);
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    write(repo, files);
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Start");
    return repo;
  }

  const PUBLIC = {
    ".gitignore": "node_modules/\n\n# Planning material kept only on the maintainer machine\nprivate/\n",
    "README.md": "# A repository\n",
    "docs/install.md": "# Installing\n",
    "packages/cli/src/index.ts": "export {};\n",
    "openspec/changes/add-tiehall-oss-v1/design.md": "# Design\n",
  };

  it("passes on a repository whose files all lie within the allowlist and whose .gitignore ignores private/", () => {
    const repo = repository(PUBLIC);
    // An ignored file in private/ is no tracked file.
    write(repo, { "private/docs/HANDOFF.md": "# Notes\n" });

    const run = check(repo);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("All 5 tracked files lie within the allowlist");
    expect(run.stdout).toContain("private/ is git-ignored");
  });

  it("fails on a tracked file outside the allowlist, printing each such path alone on its own line", () => {
    const repo = repository({ ...PUBLIC, "docs/HANDOFF.md": "# Notes\n", "notes/todo list.md": "- a\n" });

    const run = check(repo);
    expect(run.status).toBe(1);
    expect(outside(run.stdout)).toEqual(["docs/HANDOFF.md", "notes/todo list.md"]);
    expect(run.stderr).toContain("2 tracked files lie outside the allowlist of paths the public repository holds");
    expect(run.stderr).toContain("tools/repo-checks/public-paths.json");
  });

  it("fails on a file that git tracks although private/ is ignored, as `git add --force` adds one", () => {
    const repo = repository(PUBLIC);
    write(repo, { "private/docs/HANDOFF.md": "# Notes\n" });
    git(repo, "add", "--force", "private/docs/HANDOFF.md");

    const run = check(repo);
    expect(run.status).toBe(1);
    expect(outside(run.stdout)).toEqual(["private/docs/HANDOFF.md"]);
  });

  it("fails when the .gitignore no longer ignores private/", () => {
    const repo = repository({ ...PUBLIC, ".gitignore": "node_modules/\n" });

    const run = check(repo);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("private/ is not git-ignored by the repository's .gitignore");
  });

  it("fails when a later line of the .gitignore takes private/ back", () => {
    const repo = repository({ ...PUBLIC, ".gitignore": "private/\n!private/\n" });

    const run = check(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("private/ is not git-ignored by the repository's .gitignore");
  });

  it("fails when only this clone's own exclude file ignores private/, which no other clone holds", () => {
    const repo = repository({ ...PUBLIC, ".gitignore": "node_modules/\n" });
    writeFileSync(join(repo, ".git", "info", "exclude"), "private/\n");

    const run = check(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("private/ is not git-ignored by the repository's .gitignore");
  });

  it("refuses a folder that is no git repository, and says why", () => {
    const folder = join(scratch, "no-repository");
    mkdirSync(folder);

    const run = check(folder);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is not in a git repository");
  });

  describe("with --history", () => {
    /** A repository whose history holds paths outside the allowlist that its tree no longer holds. */
    function repositoryWithHistory(): string {
      const repo = repository(PUBLIC);
      write(repo, { "docs/HANDOFF.md": "# Notes\n" });
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "Add the notes");
      git(repo, "rm", "--quiet", "docs/HANDOFF.md");
      git(repo, "commit", "--quiet", "-m", "Move the notes out");
      // A branch no one merged.
      git(repo, "checkout", "--quiet", "-b", "spike/github-app");
      write(repo, { "spikes/github-app/README.md": "# Spike\n" });
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "Spike");
      // A path that only a merge commit adds, which plain git log lists in no diff.
      git(repo, "checkout", "--quiet", "-b", "side", "main");
      write(repo, { "docs/agents.md": "# Agents\n" });
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "Side");
      git(repo, "checkout", "--quiet", "main");
      git(repo, "merge", "--quiet", "--no-ff", "--no-commit", "side");
      write(repo, { "deploy/compose.saas.yaml": "services: {}\n" });
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "Merge side");
      git(repo, "rm", "--quiet", "deploy/compose.saas.yaml");
      git(repo, "commit", "--quiet", "-m", "Remove the overlay");
      return repo;
    }

    it("fails on every path outside the allowlist that a commit of any ref holds, though the tree holds none", () => {
      const repo = repositoryWithHistory();
      expect(check(repo).status).toBe(0);

      const run = check(repo, "--history");
      expect(run.status).toBe(1);
      expect(outside(run.stdout)).toEqual(["deploy/compose.saas.yaml", "docs/HANDOFF.md", "spikes/github-app/README.md"]);
      expect(run.stderr).toContain("3 paths that commits of the repository's refs hold lie outside the allowlist");
    });

    it("finds a path in the history's first commit", () => {
      const repo = repository({ ...PUBLIC, "notes.md": "# Notes\n" });
      git(repo, "rm", "--quiet", "notes.md");
      git(repo, "commit", "--quiet", "-m", "Remove the notes");

      const run = spawnSync(process.execPath, [script, repo, "--history"], {
        encoding: "utf8",
        // A user's git configuration that shows no diff for a first commit changes nothing.
        env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "log.showRoot", GIT_CONFIG_VALUE_0: "false" },
      });
      expect(run.status).toBe(1);
      expect(outside(run.stdout)).toEqual(["notes.md"]);
    });

    it("passes on a history that holds only paths within the allowlist", () => {
      const repo = repository(PUBLIC);
      write(repo, { "docs/agents.md": "# Agents\n" });
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "Add a page");

      const run = check(repo, "--history");
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("All 6 paths that commits of the repository's refs hold lie within the allowlist");
    });
  });

  it("passes on the real tree", () => {
    const run = check(repoRoot);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

describe("the allowlist's patterns", () => {
  it("match a path whole, with * inside one folder and ** across folders", () => {
    expect(patternRegExp("README.md").test("README.md")).toBe(true);
    expect(patternRegExp("README.md").test("docs/README.md")).toBe(false);
    expect(patternRegExp("docs/*.md").test("docs/install.md")).toBe(true);
    expect(patternRegExp("docs/*.md").test("docs/research/notes.md")).toBe(false);
    expect(patternRegExp("packages/**").test("packages/cli/src/index.ts")).toBe(true);
    expect(patternRegExp("packages/**").test("packages")).toBe(false);
    expect(patternRegExp("packages/**").test("packagesx/a.ts")).toBe(false);
    expect(patternRegExp(".claude/skills/openspec-*/SKILL.md").test(".claude/skills/openspec-explore/SKILL.md")).toBe(true);
    expect(patternRegExp(".claude/skills/openspec-*/SKILL.md").test(".claude/skills/other/SKILL.md")).toBe(false);
    expect(patternRegExp("docs/**/log.md").test("docs/log.md")).toBe(true);
    expect(patternRegExp("docs/**/log.md").test("docs/client-matrix/2026/log.md")).toBe(true);
    expect(patternRegExp("a.b+c(d)").test("a.b+c(d)")).toBe(true);
    expect(patternRegExp("a.b").test("axb")).toBe(false);
  });

  it("take back with ! what an earlier pattern allowed, the last pattern that matches deciding", () => {
    const patterns = ["docs/*.md", "!docs/HANDOFF.md", "openspec/changes/**", "!openspec/changes/add-tiehall-beta/**", "openspec/changes/add-tiehall-beta/README.md"];
    expect(isPublic("docs/install.md", patterns)).toBe(true);
    expect(isPublic("docs/HANDOFF.md", patterns)).toBe(false);
    expect(isPublic("openspec/changes/web-ui-design/design.md", patterns)).toBe(true);
    expect(isPublic("openspec/changes/add-tiehall-beta/design.md", patterns)).toBe(false);
    expect(isPublic("openspec/changes/add-tiehall-beta/README.md", patterns)).toBe(true);
    expect(isPublic("notes.md", patterns)).toBe(false);
  });

  it.each([
    ["a leading slash", "/README.md"],
    ["a folder's trailing slash, where a folder is written folder/**", "docs/"],
    ["a dot segment", "docs/../private/**"],
    ["an empty segment", "docs//install.md"],
    ["** inside a segment", "docs/**.md"],
    ["a wildcard other than * and **", "docs/?.md"],
    ["a character class", "docs/[a-z].md"],
    ["a backslash", "docs\\install.md"],
    ["an empty pattern", ""],
  ])("refuse %s", (_case, pattern) => {
    expect(() => patternRegExp(pattern)).toThrow(/pattern/);
  });
});

describe("the committed allowlist", () => {
  const { patterns, ignored } = loadPublicPaths();

  it("keeps private/ git-ignored", () => {
    expect(ignored).toEqual(["private/"]);
  });

  it.each([
    "private/docs/HANDOFF.md",
    "docs/HANDOFF.md",
    "docs/research/notes.md",
    "docs/design/notes.md",
    "openspec/changes/add-tiehall-beta/proposal.md",
    "openspec/changes/add-tiehall-beta/specs/billing/spec.md",
    "spikes/github-app/README.md",
    "deploy/compose.saas.yaml",
    "deploy/secrets/postgres-password",
    ".env",
    "deploy/.env",
    ".claude/settings.local.json",
    ".claude/worktrees/build-public/README.md",
    "notes.md",
  ])("leaves out %s, which stays out of the public repository", (path) => {
    expect(isPublic(path, patterns)).toBe(false);
  });

  it.each([
    "README.md",
    "LICENSE",
    "docs/install.md",
    "docs/security/review-checklist.md",
    "docs/maintainers/going-public.md",
    "openspec/config.yaml",
    "openspec/changes/add-tiehall-oss-v1/design.md",
    "openspec/changes/archive/2026-11-01-add-tiehall-oss-v1/proposal.md",
    "openspec/specs/requests/spec.md",
    "packages/cli/src/index.ts",
    "apps/web/app/page.tsx",
    "actions/contract/action.yml",
    "tools/repo-checks/public-paths.json",
    ".github/workflows/ci.yml",
    "deploy/compose.yaml",
    "deploy/.env.example",
    "openapi/v1.json",
    "mcp/tools.json",
  ])("holds %s", (path) => {
    expect(isPublic(path, patterns)).toBe(true);
  });
});

describe("CI's run of the public-paths check", () => {
  it("runs it on every pull request and push to main, with nothing installed but Node", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, { permissions?: Record<string, string>; steps?: { run?: string }[] }>;
    };
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    const running = Object.values(workflow.jobs).filter(({ steps }) =>
      (steps ?? []).some(({ run }) => run === "node tools/repo-checks/src/check-public-paths.ts"),
    );
    expect(running).toHaveLength(1);
    expect(running[0]?.permissions).toEqual({ contents: "read" });
    expect((running[0]?.steps ?? []).some(({ run }) => run?.includes("pnpm install") === true)).toBe(false);

    const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["check:public-paths"]).toBe("node tools/repo-checks/src/check-public-paths.ts");
  });
});
