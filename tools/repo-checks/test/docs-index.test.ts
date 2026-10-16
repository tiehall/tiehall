import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headings, linkProblems, links, repositoryFiles } from "../src/markdown.ts";

// The docs' index (task 30.12; design.md, Decisions this change rests on:
// D38), docs/README.md, which GitHub shows under the docs/ folder that the
// footer of every page of the web UI links (packages/commands/src/
// docs-pages.ts). It groups the pages by who reads them and links every page
// of docs/, the maintainers' pages, the security review checklist with its
// records and the client-matrix log, beside the README, which links it.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const INDEX = "docs/README.md";
const index = existsSync(join(root, INDEX)) ? readFileSync(join(root, INDEX), "utf8") : "";

/** The repository paths the index links, without fragments, relative to the root. */
function linked(): string[] {
  return links(index)
    .map(({ target }) => target.split("#")[0] ?? "")
    .filter((target) => target !== "" && !/^https?:/.test(target))
    .map((target) => join("docs", target).replace(/\\/g, "/").replace(/\/$/, ""));
}

describe("the docs' index", () => {
  it("has a title, a section for each kind of reader, and links that all resolve", () => {
    expect(index.split("\n")[0]).toMatch(/^# \S/);
    const level2 = headings(index)
      .filter(({ level }) => level === 2)
      .map(({ text }) => text);
    expect(level2).toEqual(["Using Tiehall", "Running an install", "Building on Tiehall", "Maintaining Tiehall", "How Tiehall is built"]);
    expect(linkProblems(root, INDEX)).toEqual([]);
  });

  it("links every other page of docs/, every page of the maintainers and of the security review, and the client-matrix log", () => {
    const pages = [...repositoryFiles(root)].filter(
      (file) => file !== INDEX && (/^docs\/[^/]+\.md$/.test(file) || /^docs\/(maintainers|security)\/[^/]+\.md$/.test(file) || file === "docs/client-matrix/log.md"),
    );
    expect(pages).toEqual(expect.arrayContaining(["docs/install.md", "docs/maintainers/going-public.md", "docs/security/review-checklist.md", "docs/client-matrix/log.md"]));
    expect(pages.filter((page) => !linked().includes(page))).toEqual([]);
    expect(linked()).toEqual(expect.arrayContaining(["docs/security/reviews", "README.md", "CONTRIBUTING.md", "SECURITY.md", "packages/packet/README.md", "actions/contract/README.md"]));
  });

  it("is linked from the README's Documentation section", () => {
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`](${INDEX})`);
  });
});
