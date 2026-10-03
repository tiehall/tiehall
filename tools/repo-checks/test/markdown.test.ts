import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headingAnchor, headings, linkProblems, links, section } from "../src/markdown.ts";

// What the docs checks read from Markdown (tasks 28.2 to 28.7): headings with
// the anchors GitHub gives them, the section under a heading, the links
// outside code, and the links that do not resolve, on inline fixtures.

const PAGE = [
  "# Installing Tiehall",
  "",
  "Read [the setup](#the-setup-screen) and [TLS](#tls-with-the-caddy-profile).",
  "",
  "## Write `.env` with `init`",
  "",
  "```sh",
  "# not a heading, and [not a link](nowhere.md)",
  "```",
  "",
  "## The setup screen",
  "",
  "### TLS with the caddy profile",
  "",
  "Text with `[code](not-a-link.md)` and [a page](other.md#a-heading).",
  "",
  "## Backups",
  "",
  "## Backups",
].join("\n");

describe("the headings of a page", () => {
  it("are read outside fenced blocks, with GitHub's anchors, a repeated one numbered", () => {
    expect(headings(PAGE).map(({ level, text, anchor }) => [level, text, anchor])).toEqual([
      [1, "Installing Tiehall", "installing-tiehall"],
      [2, "Write `.env` with `init`", "write-env-with-init"],
      [2, "The setup screen", "the-setup-screen"],
      [3, "TLS with the caddy profile", "tls-with-the-caddy-profile"],
      [2, "Backups", "backups"],
      [2, "Backups", "backups-1"],
    ]);
    expect(headingAnchor("What an install connects to: GitHub, Jira & SMTP")).toBe("what-an-install-connects-to-github-jira--smtp");
  });

  it("give the section under a heading, up to the next heading of its level or higher", () => {
    expect(section(PAGE, "The setup screen")?.trim()).toBe("### TLS with the caddy profile\n\nText with `[code](not-a-link.md)` and [a page](other.md#a-heading).");
    expect(section(PAGE, "TLS with the caddy profile")?.trim()).toBe("Text with `[code](not-a-link.md)` and [a page](other.md#a-heading).");
    expect(section(PAGE, "Nowhere")).toBeUndefined();
  });
});

describe("the links of a page", () => {
  it("are the inline links outside fenced blocks and code spans", () => {
    expect(links(PAGE).map(({ text, target }) => [text, target])).toEqual([
      ["the setup", "#the-setup-screen"],
      ["TLS", "#tls-with-the-caddy-profile"],
      ["a page", "other.md#a-heading"],
    ]);
  });

  it("include reference-style definitions and HTML links and images, outside fenced blocks and code spans", () => {
    const page = [
      "# A page",
      "",
      "See [the plan][plan], [the setup] [setup] and <a href=\"docs/install.md#the-setup-screen\">the install</a>, with <img src='docs/logo.svg' alt='logo'>.",
      "Code: `<a href=\"in-code.md\">` and `[x]: in-code.md`.",
      "",
      "```md",
      "[fenced]: fenced.md",
      "<a href=\"fenced.md\">fenced</a>",
      "```",
      "",
      "[plan]: private/docs/plan.md",
      "  [Setup]: <docs/install.md#the-setup-screen> \"The setup screen\"",
      "[site]: https://tiehall.com/",
    ].join("\n");
    expect(links(page).map(({ text, target, line }) => [text, target, line])).toEqual([
      ["the install", "docs/install.md#the-setup-screen", 3],
      ["logo", "docs/logo.svg", 3],
      ["plan", "private/docs/plan.md", 11],
      ["Setup", "docs/install.md#the-setup-screen", 12],
      ["site", "https://tiehall.com/", 13],
    ]);
  });

  describe("that do not resolve", () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "tiehall-markdown-"));
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(root, "packages/cli"), { recursive: true });
      writeFileSync(join(root, "docs/install.md"), "# Install\n\n## The setup screen\n");
      writeFileSync(join(root, "packages/cli/LICENSE"), "Apache License\n");
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const files = new Set(["README.md", "docs/install.md", "packages/cli/LICENSE"]);

    it("are a path to no file of the repository, a path out of it, and a heading the page lacks", () => {
      writeFileSync(
        join(root, "README.md"),
        [
          "# Tiehall",
          "",
          "[Install](docs/install.md), [setup](docs/install.md#the-setup-screen), [the CLI](packages/cli), [its license](packages/cli/LICENSE) and [the site](https://tiehall.com/).",
          "[Here](#tiehall) and [up](../outside.md), [the plan](private/docs/plan.md), [a missing heading](docs/install.md#backups) and [a fragment on a file](packages/cli/LICENSE#top).",
          "[Not here](#nowhere).",
        ].join("\n"),
      );
      expect(linkProblems(root, "README.md", files).map(({ target, problem }) => [target, problem])).toEqual([
        ["../outside.md", "points outside the repository"],
        ["private/docs/plan.md", "points to private/docs/plan.md, which the repository does not hold"],
        ["docs/install.md#backups", "names the heading #backups, which docs/install.md does not have"],
        ["packages/cli/LICENSE#top", "names the heading #top in packages/cli/LICENSE, which is no Markdown page"],
        ["#nowhere", "names the heading #nowhere, which README.md does not have"],
      ]);
    });

    it("are found in reference-style definitions and HTML links too", () => {
      writeFileSync(join(root, "docs/refs.md"), "# Refs\n\nSee [the plan][plan] and <a href=\"../nowhere.md\">this</a>.\n\n[plan]: ../private/docs/plan.md\n");
      expect(linkProblems(root, "docs/refs.md", new Set([...files, "docs/refs.md"])).map(({ target, problem }) => [target, problem])).toEqual([
        ["../nowhere.md", "points to nowhere.md, which the repository does not hold"],
        ["../private/docs/plan.md", "points to private/docs/plan.md, which the repository does not hold"],
      ]);
    });

    it("are resolved from the page's own folder", () => {
      writeFileSync(join(root, "docs/agents.md"), "# Agents\n\nSee [the install](install.md#the-setup-screen) and [the README](../README.md).\n");
      expect(linkProblems(root, "docs/agents.md", new Set([...files, "docs/agents.md"]))).toEqual([]);
    });
  });
});
