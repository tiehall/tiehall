import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { docsCommands, fencedBlocks } from "../src/docs-commands.ts";
import { headings, linkProblems, links, section } from "../src/markdown.ts";
import { taskStates } from "../src/plan.ts";

// The checklist for making the repository public (task 30.2; design.md,
// Decisions this change rests on: D38), docs/maintainers/going-public.md.
// Each item is a `### GP-<n> <title>` heading with what to do and one or more
// `- Evidence:` lines, each linking what shows that the item holds: a check
// or a test of the repository, a file, a workflow, or GitHub's documentation
// of a setting that a command reads back. The check finds an item for each
// step the plan and the maintainer named, every item linked to its evidence,
// every link resolving, every task it names being one of the plan's, every
// pnpm script one of the repository's, the required checks of the branch
// protection being the jobs CI runs, and nothing personal in the page. The
// scans for personal data of GP-2 and GP-7 are `sh` blocks named in their
// info strings, such as ```sh docs-test=history-personal-data, which the
// check runs on scratch repositories.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PATH = "docs/maintainers/going-public.md";
const checklist = existsSync(join(root, PATH)) ? readFileSync(join(root, PATH), "utf8") : "";

interface Item {
  id: string;
  title: string;
  text: string;
}

/** The checklist's items, in order. */
function items(): Item[] {
  return headings(checklist)
    .filter(({ level, text }) => level === 3 && /^GP-\d+ /.test(text))
    .map(({ text }) => {
      const [id = "", ...rest] = text.split(" ");
      return { id, title: rest.join(" "), text: section(checklist, text) ?? "" };
    });
}

/** The text of the item with this id, such as GP-7, or "" when there is none. */
const item = (id: string) => items().find((found) => found.id === id)?.text ?? "";

/** The steps the checklist must cover, each found in one item's title. */
const STEPS = [
  "allowlist",
  "nothing personal or secret",
  "license files",
  "README",
  "CONTRIBUTING",
  "SECURITY",
  "rewrite the history",
  "secret scan",
  "path scan",
  "pull request refs",
  "description, homepage and topics",
  "social preview",
  "private vulnerability reporting",
  "branch protection",
  "workflow permissions",
  "image's package",
  "organization's settings",
  "organization's profile",
  "switch to public",
  "first public release",
  "Actions minutes",
  "landing page",
];

describe("the checklist for making the repository public", () => {
  it("numbers its items GP-1, GP-2 and so on, in order", () => {
    const ids = items().map(({ id }) => id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(ids.map((_id, index) => `GP-${index + 1}`));
  });

  it("has an item for each step of making the repository public", () => {
    const titles = items().map(({ title }) => title.toLowerCase());
    expect(STEPS.filter((step) => !titles.some((title) => title.includes(step.toLowerCase())))).toEqual([]);
  });

  it("links every item to its evidence", () => {
    const unlinked = items().flatMap(({ id, text }) => {
      const evidence = text.split("\n").filter((line) => line.startsWith("- Evidence: "));
      if (evidence.length === 0) return [`${id}: no evidence`];
      return evidence.filter((line) => links(line).length === 0).map((line) => `${id}: ${line}`);
    });
    expect(unlinked).toEqual([]);
  });

  it("names only tasks of the plan", () => {
    const plan = taskStates(readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/tasks.md"), "utf8"));
    const named = [...checklist.matchAll(/\b[Tt]asks? (\d+\.\d+)(?:(?:,| and| to) (\d+\.\d+))*/g)].flatMap((match) =>
      [...match[0].matchAll(/\d+\.\d+/g)].map(([task]) => task),
    );
    expect(named.length).toBeGreaterThan(5);
    expect([...new Set(named)].filter((task) => !plan.has(task))).toEqual([]);
  });

  it("has links that all resolve, and the contributors' guide links it", () => {
    expect(linkProblems(root, PATH)).toEqual([]);
    expect(links(readFileSync(join(root, "CONTRIBUTING.md"), "utf8")).map(({ target }) => target)).toContain(PATH);
  });

  it("names only pnpm scripts the repository has, and only the repository's own scripts by path", () => {
    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const spans = [...checklist.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    const commands = [...spans, ...fencedBlocks(checklist).map(({ text }) => text)].join("\n");
    const named = [...commands.matchAll(/\bpnpm (?!install\b|-r\b|--filter\b|exec\b|vitest\b)([a-z][a-z0-9:-]*)/g)].map((match) => match[1] ?? "");
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)].filter((name) => !Object.hasOwn(scripts, name))).toEqual([]);
    const paths = [...commands.matchAll(/\btools\/repo-checks\/src\/[\w-]+\.ts\b/g)].map(([path]) => path);
    expect(paths.length).toBeGreaterThan(0);
    expect([...new Set(paths)].filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });

  it("lists, as the branch protection's required checks, the jobs that CI runs on a pull request", () => {
    type Job = { name?: string; needs?: string | string[]; uses?: string };
    const workflow = (file: string) => parse(readFileSync(join(root, ".github/workflows", file), "utf8")) as { jobs: Record<string, Job> };
    const ci = workflow("ci.yml").jobs;
    // The test job passes only when the typecheck and every shard passed, so it is the one the protection requires.
    const folded = new Set([ci["test"]?.needs ?? []].flat());
    const expected = [
      ...Object.entries(ci).flatMap(([id, job]) => {
        if (folded.has(id)) return [];
        if (job.uses === "./.github/workflows/image-checks.yml") {
          return Object.values(workflow("image-checks.yml").jobs).map((called) => `${job.name} / ${called.name}`);
        }
        return [job.name ?? id];
      }),
      ...Object.values(workflow("api-compatibility.yml").jobs).map((job) => job.name ?? ""),
    ];
    const line = checklist.split("\n").find((text) => text.startsWith("- Required checks: ")) ?? "";
    const listed = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    expect(listed.sort()).toEqual(expected.sort());
  });

  it("rewrites a fresh clone, as filter-repo requires, and gives the rewritten clone its remote only to push it", () => {
    const gp7 = item("GP-7");
    const rewrite = gp7.indexOf("git filter-repo");
    expect(rewrite).toBeGreaterThan(-1);
    // filter-repo refuses a clone whose origin is gone unless forced, which turns off its other checks too, and
    // removes origin itself after the rewrite.
    expect(gp7.slice(0, rewrite)).not.toMatch(/\bremote (?:remove|rm) origin\b/);
    expect(gp7).not.toMatch(/git filter-repo [^\n`]*--force/);
    expect(item("GP-10")).toContain("git remote add origin https://github.com/tiehall/tiehall.git");
  });

  it("keeps personal data out: the repository's public address only, no mailbox, no local path, no earlier email", () => {
    expect(checklist).toContain("github.com/tiehall/tiehall");
    expect(links(checklist).filter(({ target }) => target.startsWith("mailto:"))).toEqual([]);
    expect(checklist).not.toMatch(/security@tiehall\.com/i);
    expect(checklist).not.toMatch(/gmail\.com/i);
    // A home folder's path names its owner; the bare prefixes, as a search names them, do not.
    expect(checklist).not.toMatch(/\/(?:Users|home)\/\w/);
    // Every address it names is the public identity the history will show, or a placeholder.
    const addresses = [...checklist.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([address]) => address);
    expect([...new Set(addresses)].filter((address) => !address.endsWith("@users.noreply.github.com"))).toEqual([]);
  });

  it("says what each part is for in its opening, and names the founder steps", () => {
    const level2 = headings(checklist)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(level2.length).toBeGreaterThanOrEqual(3);
    expect(checklist).toContain("founder step");
  });
});

describe("the checklist's scans for personal data", () => {
  let scratch: string;
  let count = 0;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "tiehall-going-public-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** What names the fixture's maintainer: personal.txt, kept beside the checkout and the clone. */
  const PERSONAL = "kq7user\nkq7@example.invalid\n";
  /** A personal.txt whose one line no fixture holds, so only the search for any home folder's path finds anything. */
  const NO_ONE = "no-such-name-anywhere\n";

  function git(cwd: string, ...args: string[]): void {
    const run = spawnSync(
      "git",
      ["-c", "user.name=Public Author", "-c", "user.email=public@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }

  function commit(repo: string, files: Record<string, string | Buffer>, ...args: string[]): void {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--allow-empty", ...args);
  }

  /** A folder of its own holding personal.txt and a repository, <folder>/<name>, whose first commit holds the files given. */
  function repository(name: string, files: Record<string, string | Buffer>): string {
    const repo = join(scratch, `workspace-${++count}`, name);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    commit(repo, files, "-m", "Start");
    return repo;
  }

  /** What the checklist's block with this name prints, run with sh in the repository with this personal.txt beside it. */
  function scan(name: string, repo: string, personal: string): string {
    const command = docsCommands(checklist).find(({ id }) => id === name);
    expect(command, `${PATH} holds no block named ${name}`).toBeDefined();
    writeFileSync(join(repo, "..", "personal.txt"), personal);
    const run = spawnSync("sh", ["-c", command?.text ?? ""], {
      cwd: repo,
      encoding: "utf8",
      // A user's git configuration that shows no diff for a first commit changes nothing.
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "log.showRoot", GIT_CONFIG_VALUE_0: "false" },
    });
    if (run.error) throw run.error;
    expect(run.stderr).toBe("");
    return run.stdout;
  }

  /** Text that names no one: a web address whose path holds home, and a relative folder named home. */
  const LINKS = "See https://example.com/news/home/2026 and ./home/readme.\n";

  it("GP-2 finds, in the tree, each line of personal.txt and any home folder's path, written with slashes or dashes", () => {
    expect(item("GP-2")).toContain("docs-test=tree-personal-data");
    const repo = repository("checkout", {
      "docs/notes.md": "Kept in /Users/kq7user/notes.\n",
      "tools/backup.test.ts": "writeFileSync(`/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt`);\n",
      "docs/contact.md": "Write to kq7@example.invalid.\n",
      "docs/links.md": LINKS,
    });

    const named = scan("tree-personal-data", repo, PERSONAL);
    for (const hit of ["docs/notes.md:1:", "tools/backup.test.ts:1:", "docs/contact.md:1:"]) expect(named).toContain(hit);
    expect(named).not.toContain("docs/links.md");

    const anyHome = scan("tree-personal-data", repo, NO_ONE);
    for (const hit of ["docs/notes.md:1:", "tools/backup.test.ts:1:"]) expect(anyHome).toContain(hit);
    expect(anyHome).not.toContain("docs/contact.md");
    expect(anyHome).not.toContain("docs/links.md");
  });

  describe("GP-7, over the rewritten history", () => {
    /**
     * A history whose personal data only a first commit, a file a later
     * commit removed, a binary file, an author, a message and a merge's
     * resolution hold, the merge at the tip of a branch that is not checked out.
     */
    function history(): string {
      const repo = repository("tiehall-public", { "README.md": "# App\n", "tools/first.ts": 'export const note = "first commit only: kq7user";\n' });
      commit(repo, { "tools/backup.test.ts": "writeFileSync(`/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt`);\n" }, "-m", "Write the output");
      git(repo, "rm", "--quiet", "tools/backup.test.ts");
      commit(repo, {}, "-m", "Stop writing the output");
      const binary = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("binary only: kq7user"), Buffer.from([0, 255])]);
      commit(repo, { "tools/icon.bin": binary }, "--author=Pat <kq7@example.invalid>", "-m", "Add the icon");
      commit(repo, { "docs/links.md": LINKS }, "-m", "Add the links\n\nmessage only: kq7user ran it in /Users/kq7user/app");
      git(repo, "checkout", "--quiet", "-b", "side");
      commit(repo, { "docs/side.md": "# Side\n" }, "-m", "Side");
      git(repo, "checkout", "--quiet", "-b", "hosted", "main");
      git(repo, "merge", "--quiet", "--no-ff", "--no-commit", "side");
      commit(repo, { "deploy/merged.txt": "merge resolution only: kq7user\n" }, "-m", "Merge side");
      git(repo, "checkout", "--quiet", "main");
      return repo;
    }

    it("finds each line of personal.txt in every identity, message and line a commit adds or removes, binary files too", () => {
      const found = scan("history-personal-data", history(), PERSONAL);
      for (const hit of [
        "first commit only: kq7user",
        "-Users-kq7user-Projects-app",
        "binary only: kq7user",
        "Pat <kq7@example.invalid>",
        "message only: kq7user",
        "merge resolution only: kq7user",
      ]) {
        expect(found).toContain(hit);
      }
      expect(found).not.toContain("news/home");
    });

    it("finds any home folder's path, written with slashes or dashes, that personal.txt does not name", () => {
      const found = scan("history-personal-data", history(), NO_ONE);
      expect(found).toContain("-Users-kq7user-Projects-app");
      expect(found).toContain("/Users/kq7user/app");
      expect(found).not.toContain("first commit only");
      expect(found).not.toContain("news/home");
      expect(found).not.toContain("./home/readme");
    });

    it("scans the clone once rewritten, and rewrites what it finds from a fresh clone, messages included", () => {
      const gp7 = item("GP-7");
      const rewrite = gp7.indexOf("git filter-repo --invert-paths");
      expect(rewrite).toBeGreaterThan(-1);
      expect(gp7.indexOf("docs-test=history-personal-data")).toBeGreaterThan(rewrite);
      expect(gp7).toContain("--replace-text ../replacements.txt --replace-message ../replacements.txt");
    });
  });
});
