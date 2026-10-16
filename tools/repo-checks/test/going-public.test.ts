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
import { trackedTextFiles } from "../src/tracked-files.ts";

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
// scans for personal data of GP-2 and GP-7 and GP-7's read-back of the
// identities are `sh` blocks named in their info strings, such as ```sh
// docs-test=history-personal-data, which the check runs on scratch
// repositories.

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

  it("leaves the rewritten main alone on GitHub, with no other branch, tag or pull request ref beside it", () => {
    const gp10 = item("GP-10");
    // A force push replaces main alone: the current repository's other branches keep the old history.
    expect(gp10).toContain("git push origin --delete <branch>");
    const readBack = gp10.split("\n").find((line) => line.startsWith("- Read back: ")) ?? "";
    expect(readBack).toContain("`git ls-remote https://github.com/tiehall/tiehall.git`");
    expect(readBack).toContain("nothing else: no other branch, no tag and no pull request ref");
  });

  it("keeps personal data out: the repository's public address only, no mailbox, no local path, no earlier email", () => {
    expect(checklist).toContain("github.com/tiehall/tiehall");
    expect(links(checklist).filter(({ target }) => target.startsWith("mailto:"))).toEqual([]);
    expect(checklist).not.toMatch(/security@tiehall\.com/i);
    expect(checklist).not.toMatch(/gmail\.com/i);
    // A home folder's path names its owner; the bare prefixes, as a search names them, do not.
    expect(checklist).not.toMatch(/\/(?:Users|home)\/\w/);
    // Every address it names is the public identity the history will show, or GitHub's own committer of merges made on the web.
    const addresses = [...checklist.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(([address]) => address);
    expect([...new Set(addresses)].filter((address) => !address.endsWith("@users.noreply.github.com") && address !== "noreply@github.com")).toEqual([]);
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

    it("reads back, once rewritten, every author and committer of every ref, each once", () => {
      const gp7 = item("GP-7");
      const readBack = gp7.split("\n").find((line) => line.startsWith("- Read back the identities")) ?? "";
      expect(readBack).toContain("the command below");
      expect(gp7.indexOf("docs-test=history-identities")).toBeGreaterThan(gp7.indexOf("docs-test=history-rewrite"));
      // A committer that is no commit's author, on a branch that is not checked out, as GitHub commits a merge made on the web.
      const repo = history();
      git(repo, "checkout", "--quiet", "-b", "web");
      commit(repo, { "docs/web.md": "# Web\n" }, "-m", "Web");
      git(repo, "-c", "user.name=Web Committer", "-c", "user.email=web@example.invalid", "commit", "--quiet", "--amend", "--no-edit");
      git(repo, "checkout", "--quiet", "main");
      expect(scan("history-identities", repo, NO_ONE).split("\n").filter((line) => line !== "")).toEqual([
        "Pat <kq7@example.invalid>",
        "Public Author <public@example.invalid>",
        "Web Committer <web@example.invalid>",
      ]);
    });

    it("scans the clone once rewritten, and rewrites what it finds from a fresh clone, messages included", () => {
      const gp7 = item("GP-7");
      const rewrite = gp7.indexOf("docs-test=history-rewrite");
      expect(rewrite).toBeGreaterThan(-1);
      expect(gp7.indexOf("docs-test=history-personal-data")).toBeGreaterThan(rewrite);
      const command = rewriteCommand();
      expect(command).toContain(`--replace-text ${REWRITE}/replace-text.txt`);
      expect(command).toContain(`--replace-message ${REWRITE}/replace-text.txt`);
    });
  });
});

// The rewrite's plan (task 30.9): GP-7 names what the scans of every branch's
// history found, by commit and path and never by value, and gives the one
// `git filter-repo` command of task 30.3, whose files are kept in
// docs/maintainers/history-rewrite/. The mailmap names the public author
// alone; the maintainer's own address is replaced by --email-callback, which
// names no address of theirs. Each line of replace-text.txt, which
// filter-repo reads for --replace-text and --replace-message alike, is a
// pattern that names no personal value: the check applies the rules, as
// filter-repo does with Python's re.sub, to made-up fixtures of each finding's
// form, and to every file of the tree, which they leave as it is.

/** The example ids that stand for the spikes' App, account and installation (packages/testing/test/fixtures/github-app-spike/README.md). */
const EXAMPLE_IDS = new Set(["1000001", "2000001", "3000001"]);

/** The rewrite's files, from the root and from the clone's root alike. */
const REWRITE = "docs/maintainers/history-rewrite";

/** The rewrite's command, the block of GP-7 named history-rewrite, as one line. */
function rewriteCommand(): string {
  return (docsCommands(item("GP-7")).find(({ id }) => id === "history-rewrite")?.text ?? "").replace(/\\\n\s*/g, " ");
}

/** One rule of replace-text.txt: a pattern, and its replacement in Python's re.sub form. */
interface Rule {
  line: string;
  pattern: RegExp;
  replacement: string;
}

/** The rules of replace-text.txt, as filter-repo reads them: a line is a rule, split at its last ==>. */
function rules(): Rule[] {
  const text = readFileSync(join(root, REWRITE, "replace-text.txt"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const at = line.lastIndexOf("==>");
      const [pattern, replacement] = at === -1 ? [line, "***REMOVED***"] : [line.slice(0, at), line.slice(at + 3)];
      // A literal rule names the very text it removes; only a pattern can name none.
      expect(pattern.startsWith("regex:"), line).toBe(true);
      return { line, pattern: new RegExp(pattern.slice("regex:".length), "g"), replacement };
    });
}

/** The text with every rule applied in order, a replacement's \1 or \g<1> standing for a group and \n for a newline, as in re.sub. */
function applyRules(text: string): string {
  return rules().reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, (...match: unknown[]) =>
        replacement.replace(/\\(?:g<(\d+)>|(\d+)|n)/g, (_escape, named?: string, numbered?: string) =>
          named === undefined && numbered === undefined ? "\n" : String(match[Number(named ?? numbered)] ?? ""),
        ),
      ),
    text,
  );
}

describe("the rewrite's command and its files", () => {
  /** The public author's no-reply address, as GP-7 names it. */
  const publicAddress = /`[^`<]+<(\d+\+[\w-]+@users\.noreply\.github\.com)>`/.exec(item("GP-7"))?.[1] ?? "";

  it("removes the paths outside the allowlist and maps every identity to the public author, GitHub's own aside", () => {
    expect(publicAddress).not.toBe("");
    const command = rewriteCommand();
    expect(command).toMatch(/^git filter-repo --invert-paths --paths-from-file \.\.\/outside\.txt /);
    expect(command).toContain(`--mailmap ${REWRITE}/mailmap`);
    // filter-repo runs the body as def email_callback(email): ..., on bytes.
    expect(command).toContain(`--email-callback 'return email if email == b"noreply@github.com" else b"${publicAddress}"'`);
    expect(command).not.toMatch(/--force\b/);
    for (const [, path] of command.matchAll(/\s(docs\/maintainers\/history-rewrite\/\S+)/g)) expect(existsSync(join(root, path ?? "")), path).toBe(true);
  });

  it("has a mailmap that names the public author alone, by their no-reply address", () => {
    const lines = readFileSync(join(root, REWRITE, "mailmap"), "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => line !== "");
    const author = /`([^`<]+) <\d+\+[\w-]+@users\.noreply\.github\.com>`/.exec(item("GP-7"))?.[1] ?? "";
    expect(lines).toEqual([`${author} <${publicAddress}> <${publicAddress}>`]);
  });

  it("names no personal value in a rule: patterns only, with no address, home folder, user name or identifier", () => {
    const user = /\+([\w-]+)@/.exec(publicAddress)?.[1] ?? "";
    expect(user).not.toBe("");
    for (const { line } of rules()) {
      expect(line, line).not.toMatch(/@/);
      expect(line, line).not.toMatch(/\/(?:Users|home)\/\w|-(?:Users|home)-\w/);
      expect([...line.matchAll(/\d{5,}/g)].map(([number]) => number).filter((number) => !EXAMPLE_IDS.has(number)), line).toEqual([]);
      expect(line, line).not.toMatch(/Iv1\.|Iv23li/);
      expect(line.toLowerCase(), line).not.toContain(user.toLowerCase());
    }
  });

  it("rewrites the form of each finding in a made-up fixture", () => {
    // An agent's scratch folder under a home folder, written with dashes (backup.test.ts, task 21.3); built from parts, so that
    // the rule leaves this file alone.
    const scratch = ["/private/tmp/claude-501", "-Users-kq7user-Projects-Tiehall", "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b", "scratchpad/fix21"].join("/");
    expect(applyRules(`      writeFileSync(\`${scratch}/restore-x.txt\`, out);\n`)).toBe("      writeFileSync(`/tmp/scratchpad/fix21/restore-x.txt`, out);\n");
    // The spikes' GitHub App's name and slug, as the fixtures of the GitHub stub held them; built from parts, so that this file holds neither.
    const name = ["Tiehall", "spike", "localhost"].join(" ");
    const slug = ["tiehall", "spike", "localhost"].join("-");
    expect(applyRules(`"name": "${name}",\n"slug": "${slug}",\n"htmlUrl": "https://github.com/apps/${slug}"\n`)).toBe(
      '"name": "Tiehall example localhost",\n"slug": "tiehall-example-localhost",\n"htmlUrl": "https://github.com/apps/tiehall-example-localhost"\n',
    );
    // The App's id, as the setup gate's test stored it beside the stub's slug.
    expect(applyRules('        id: 1234567,\n        slug: "tiehall-localhost",\n')).toBe('        id: 2000001,\n        slug: "tiehall-localhost",\n');
    // Text that only looks alike stays.
    const alike = 'id: 1234567,\nname: "x"\n/private/tmp/claude-501/-Users-kq7user-Projects-app/out.txt Tiehall spikes localhost\n';
    expect(applyRules(alike)).toBe(alike);
  });

  it("changes no file of the tree, which holds the rewritten values already", () => {
    const changed = trackedTextFiles(root)
      .filter(({ text }) => applyRules(text) !== text)
      .map(({ path }) => path);
    expect(changed).toEqual([]);
  });

  it("names each finding of the scans by its commit and path, and no value", () => {
    const gp7 = item("GP-7");
    for (const path of [
      "tools/image-tests/test/install/backup.test.ts",
      "packages/commands/test/setup-gate.test.ts",
      "packages/testing/test/github-stub-contract.test.ts",
      "spikes/mcp-auth/src/app.js",
    ]) {
      expect(gp7, path).toContain(`\`${path}\``);
    }
    for (const commit of ["b2898ea4", "2af52a9d", "019680b3", "bbaf7edd", "1d7ee604", "6099409f"]) expect(gp7, commit).toContain(`\`${commit}\``);
    for (const branch of ["spike/github-app", "spike/m0-claude-hooks", "spike/m0-mcp-auth"]) expect(gp7, branch).toContain(`\`${branch}\``);
    // No App id, installation id or client id: no number of six or more digits but the public author's user id.
    const numbers = [...checklist.matchAll(/(?<![\w.])\d{6,}(?![\w.])/g)].map(([number]) => number);
    expect(numbers.filter((number) => !publicAddress.startsWith(`${number}+`) && !EXAMPLE_IDS.has(number))).toEqual([]);
    expect(checklist).not.toMatch(/Iv1\.[0-9a-f]|Iv23li/);
  });
});
