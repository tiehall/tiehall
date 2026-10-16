import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fencedBlocks } from "../src/docs-commands.ts";
import { headingAnchor, headings, linkProblems, links, section } from "../src/markdown.ts";

// What the maintainer applies on GitHub (task 30.14; design.md, Decisions
// this change rests on: D38), drafted in docs/maintainers/github-profile.md:
// the repository's description and topics (GP-11), the social preview
// (GP-12), and the organization's description, avatar and profile README
// for tiehall/.github (GP-18). Each value is a fenced block named in its
// info string, such as ```text github-profile=description, so this check
// reads exactly what the maintainer copies: GitHub's limits on each, the
// README's own sentence as the description, the command that sets both,
// links of the profile README that reach the public repository's own files,
// and no email address anywhere.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE = "docs/maintainers/github-profile.md";
const page = existsSync(join(root, PAGE)) ? readFileSync(join(root, PAGE), "utf8") : "";
const checklist = readFileSync(join(root, "docs/maintainers/going-public.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

/** The text of the fenced block this name gives, without its last line break. */
function block(name: string): string {
  return fencedBlocks(page).find(({ info }) => info.split(/\s+/).includes(`github-profile=${name}`))?.text.trim() ?? "";
}

/** The README's one sentence of what Tiehall is: the paragraph under its name. */
function readmeSentence(): string {
  const header = readme.split(/^## /m)[0] ?? "";
  const paragraph = [...header.matchAll(/<p align="center">\s*([^<]+?)\s*<\/p>/g)].map(([, text = ""]) => text.replace(/\s+/g, " ")).find((text) => text.startsWith("Tiehall "));
  return paragraph ?? "";
}

/** The repository file or README heading a link of the profile README reaches, or why it reaches none. */
function reached(target: string): string {
  const repository = /^https:\/\/github\.com\/tiehall\/tiehall(?:\/(?:blob|tree)\/main\/([^#]+))?(?:#(.+))?$/.exec(target);
  const raw = /^https:\/\/raw\.githubusercontent\.com\/tiehall\/tiehall\/main\/([^#]+)$/.exec(target);
  const path = repository?.[1] ?? raw?.[1];
  if (repository === null && raw === null) return `not an address of the public repository: ${target}`;
  if (path !== undefined) return existsSync(join(root, path)) ? path : `no such file: ${path}`;
  const anchor = repository?.[2];
  if (anchor === undefined) return "the repository";
  return headings(readme).some((heading) => heading.anchor === anchor) ? `README#${anchor}` : `no such heading of the README: ${anchor}`;
}

describe("the drafts of what the maintainer applies on GitHub", () => {
  it("are a page with a title whose links all resolve", () => {
    expect(page.split("\n")[0]).toMatch(/^# \S/);
    expect(linkProblems(root, PAGE)).toEqual([]);
  });

  it("give the repository's description as the README's own sentence, within GitHub's 350 characters", () => {
    const description = block("description");
    expect(description).not.toBe("");
    expect(description).not.toContain("\n");
    expect(description.length).toBeLessThanOrEqual(350);
    expect(readmeSentence()).not.toBe("");
    expect(description).toBe(readmeSentence());
  });

  it("give at most 20 topics, each of lowercase letters, digits and hyphens and at most 50 characters", () => {
    const topics = block("topics").split("\n");
    expect(topics.length).toBeGreaterThan(5);
    expect(topics.length).toBeLessThanOrEqual(20);
    expect(new Set(topics).size).toBe(topics.length);
    expect(topics.filter((topic) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic))).toEqual([]);
    expect(topics).toEqual(expect.arrayContaining(["coding-agents", "mcp", "self-hosted", "claude-code"]));
  });

  it("set both with one command, which names the same description and topics", () => {
    const command = fencedBlocks(page).find(({ info, text }) => info === "sh" && text.startsWith("gh repo edit tiehall/tiehall"))?.text ?? "";
    expect(command).toContain(`--description "${block("description")}"`);
    expect(command).toContain(`--add-topic ${block("topics").split("\n").join(",")}`);
  });

  it("give the organization's description within GitHub's 160 characters, with no address", () => {
    const description = block("organization-description");
    expect(description).not.toBe("");
    expect(description).not.toContain("\n");
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description).not.toMatch(/https?:|@/);
  });

  it("draft the organization's profile README, whose every link is an HTTPS address of the public repository that reaches a file or heading of it", () => {
    const profile = block("profile-readme");
    expect(profile).toMatch(/^<p align="center">|^# /);
    const targets = links(profile).map(({ target }) => target);
    expect(targets.length).toBeGreaterThan(3);
    expect(targets.map(reached).filter((found) => /^(not an address|no such)/.test(found))).toEqual([]);
    expect(targets.map(reached)).toEqual(expect.arrayContaining(["docs/assets/brand/mark.svg", "docs/install.md", "SECURITY.md", `README#${headingAnchor("Connect your agents")}`]));
  });

  it("link the film where it plays, the repository's README, and not the MP4, whose page on GitHub shows no player", () => {
    const profile = block("profile-readme");
    const film = links(profile).filter(({ text }) => /\bfilm\b/i.test(text));
    expect(film.map(({ target }) => reached(target))).toEqual(["the repository"]);
    expect(links(profile).filter(({ target }) => /\.mp4$/i.test(target))).toEqual([]);
  });

  it("name no email address, since no mailbox exists yet", () => {
    expect(page).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(page).not.toMatch(/mailto:/i);
  });

  it("are linked from GP-11, GP-12 and GP-18 of the checklist, with the social preview and the avatar they apply", () => {
    const item = (id: string) => {
      const heading = headings(checklist).find(({ level, text }) => level === 3 && text.startsWith(`${id} `));
      return section(checklist, heading?.text ?? "") ?? "";
    };
    for (const id of ["GP-11", "GP-12", "GP-18"]) expect(links(item(id)).map(({ target }) => target.split("#")[0]), id).toContain("github-profile.md");
    expect(links(item("GP-12")).map(({ target }) => target)).toContain("../assets/brand/social-preview.png");
    expect(links(item("GP-18")).map(({ target }) => target)).toContain("../assets/brand/avatar.png");
  });
});
