import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fencedBlocks } from "../src/docs-commands.ts";
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
// protection being the jobs CI runs, and nothing personal in the page.

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
