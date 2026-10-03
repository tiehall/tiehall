import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fencedBlocks, installDocsCommands } from "../src/docs-commands.ts";
import { loadLicenseMap } from "../src/licenses.ts";
import { headings, isExternal, linkProblems, links, repositoryFiles, section } from "../src/markdown.ts";

// The README of the public repository (task 28.2; design.md, Decisions this
// change rests on: D38): what Tiehall is, a quickstart taken from the install
// docs, the license of each directory and links to the docs. The check finds
// each section, finds that every link resolves, that every page of docs/ is
// linked from the Documentation section, that the quickstart runs only
// commands of the install docs, which their CI jobs run, and that the
// licenses it names by directory are the license map's.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const README = "README.md";
const readme = readFileSync(join(root, README), "utf8");

/** A section of the README, or the empty text when it has none. */
const part = (heading: string) => section(readme, heading) ?? "";

describe("the README", () => {
  it("has a section for what Tiehall is, the quickstart, the documentation and the licenses by directory", () => {
    const level2 = headings(readme).filter(({ level }) => level === 2).map(({ text }) => text);
    expect(level2).toEqual(expect.arrayContaining(["What Tiehall is", "Quickstart", "Documentation", "Licenses by directory"]));
    expect(level2.indexOf("What Tiehall is")).toBe(0);
    expect(part("What Tiehall is").replace(/\s+/g, " ")).toMatch(/Tiehall runs no LLM of its own/);
  });

  it("has links that all resolve, and none to the git-ignored planning folder", () => {
    expect(linkProblems(root, README)).toEqual([]);
    expect(links(readme).filter(({ target }) => /(^|\/)private(\/|$)/.test(target))).toEqual([]);
  });

  it("links every page of docs/ from its Documentation section", () => {
    const pages = [...repositoryFiles(root)].filter((file) => /^docs\/[^/]+\.md$/.test(file));
    expect(pages).toContain("docs/install.md");
    const linked = links(part("Documentation")).map(({ target }) => target.split("#")[0]);
    expect(pages.filter((page) => !linked.includes(page))).toEqual([]);
  });

  it("runs, in its quickstart, the install docs' commands from the download to the setup code, in their order", () => {
    const commands = installDocsCommands(root);
    // A text the install docs show twice, such as docker compose up -d, counts as its first command.
    const byText = new Map([...commands.values()].reverse().map(({ id, text }) => [text, id]));
    const quickstart = fencedBlocks(part("Quickstart")).filter(({ info }) => /^(sh|bash|shell|console)\b/.test(info));
    const ids = quickstart.map(({ text }) => byText.get(text) ?? `not a command of the install docs: ${text}`);
    expect(ids.filter((id) => ["install-download", "install-init", "install-up", "install-setup-code"].includes(id))).toEqual([
      "install-download",
      "install-init",
      "install-up",
      "install-setup-code",
    ]);
    expect(ids.filter((id) => !commands.has(id))).toEqual([]);
    expect(links(part("Quickstart")).map(({ target }) => target.split("#")[0])).toContain("docs/install.md");
  });

  it("offers a trial at http://localhost:3000 only with the install docs' advice on its cookies (task 26.15)", () => {
    const install = (section(readFileSync(join(root, "docs/install.md"), "utf8"), "Start the install") ?? "").replace(/\s+/g, " ");
    const advice = "run a trial in a browser profile that visits no other local server";
    expect(install).toContain(advice);
    const quickstart = part("Quickstart").replace(/\s+/g, " ");
    expect(quickstart).toContain("`http://localhost:3000` works without TLS");
    expect(quickstart).toContain("in a browser profile that visits no other local server");
    expect(links(part("Quickstart")).map(({ target }) => target)).toContain("docs/install.md#start-the-install");
  });

  it("names the license of each directory as the license map gives it, each with a link to its license file", () => {
    const map = loadLicenseMap();
    const licenses = part("Licenses by directory");
    const rows = licenses.split("\n").filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line));
    const apacheRows = rows.filter((row) => row.includes(map.clientLicense));
    const folders = Object.keys(map.clientPieces);
    expect(apacheRows).toHaveLength(folders.length);
    for (const folder of folders) {
      const row = apacheRows.find((candidate) => candidate.includes(`\`${folder}/\``));
      expect(row, folder).toBeDefined();
      expect(links(row ?? "").map(({ target }) => target)).toContain(`${folder}/LICENSE`);
    }
    const serverRow = rows.find((row) => row.includes("AGPL-3.0"));
    expect(links(serverRow ?? "").map(({ target }) => target)).toContain("LICENSE");
    expect(licenses).toMatch(/`packages\/catalog\/`/);
  });

  it("has no web address it cannot do without: every external link is HTTPS", () => {
    expect(links(readme).filter(({ target }) => isExternal(target) && !target.startsWith("https://"))).toEqual([]);
  });
});
