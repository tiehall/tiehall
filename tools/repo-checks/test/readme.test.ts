import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fencedBlocks, installDocsCommands } from "../src/docs-commands.ts";
import { loadLicenseMap } from "../src/licenses.ts";
import { headings, isExternal, linkProblems, links, repositoryFiles, section } from "../src/markdown.ts";
import { taskStates } from "../src/plan.ts";

// The README of the public repository (tasks 28.2 and 30.13; design.md,
// Decisions this change rests on: D38): the front door, which links into the
// docs rather than repeating them. Above its sections it shows the mark, the
// name, one sentence of what Tiehall is and the film; then what Tiehall is
// and why, how it works, what an install gives, a quickstart taken from the
// install docs, connecting agents, where it fits, security and privacy, the
// license of each directory, the status, contributing and the docs. The
// check finds each section in that order, finds that every link resolves,
// that every page of docs/ is linked from the Documentation section, that
// the quickstart runs only commands of the install docs, which their CI jobs
// run, that the licenses it names by directory are the license map's, that
// it names each agent client the client-matrix log records a sign-in for,
// and that it claims nothing the plan has not built: no Jira mirror while
// group 25 is open, and no release before the first public one (task 30.5).
// Once the repository is public it shows the film in GitHub's player, since
// GitHub's file view plays no video and a link to the MP4 only downloads it.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const README = "README.md";
const readme = readFileSync(join(root, README), "utf8");

/** A section of the README, or the empty text when it has none. */
const part = (heading: string) => section(readme, heading) ?? "";

/** The README above its first section: the mark, the name, the sentence and the film. */
const header = readme.split(/^## /m)[0] ?? "";

/** The README's sections, in the order a newcomer reads them. */
const SECTIONS = [
  "What Tiehall is",
  "How it works",
  "What you get",
  "Quickstart",
  "Connect your agents",
  "Where it fits",
  "Security and privacy",
  "Licenses by directory",
  "Status",
  "Contributing",
  "Documentation",
];

const FILM = "docs/assets/film/every-teams-line.mp4";
const POSTER = "docs/assets/film/every-teams-line-poster.jpg";

/**
 * Whether this text holds GitHub's player for a video: the address GitHub gives an attachment, on a line of its own
 * between empty lines, outside any HTML block. GitHub's file view plays no video, so a link to the committed MP4 offers
 * the film only for download (GP-4 and GP-19 of the checklist for making the repository public).
 */
const hasPlayer = (text: string) => /\n\nhttps:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+\n\n/.test(`\n\n${text}`);

/** The plan's tasks, each done or not. */
const plan = taskStates(readFileSync(join(root, "openspec/changes/add-tiehall-oss-v1/tasks.md"), "utf8"));

/** The clients that a table of the client-matrix log records a sign-in for: each row of a matrix table whose sign-in cell is more than "Not run". */
function clientsWithASignIn(): string[] {
  const log = readFileSync(join(root, "docs/client-matrix/log.md"), "utf8");
  const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const clients = new Set<string>();
  let signIn = -1;
  for (const line of log.split("\n")) {
    if (!line.startsWith("|")) signIn = -1;
    else if (line.startsWith("| Client |")) signIn = cells(line).findIndex((cell) => cell.startsWith("Sign-in path"));
    else if (signIn > 0 && !/^\|\s*-/.test(line)) {
      const [client = "", ...rest] = cells(line);
      if (rest[signIn - 1] !== "Not run" && !client.startsWith("Each of")) clients.add(client);
    }
  }
  return [...clients];
}

/** The README's sentences outside code, each with its white space made single spaces. */
function sentences(): string[] {
  const prose = readme.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "code");
  return prose
    .split(/(?<=[.!?])\s+|\n\s*\n|\n(?=[-|<]|\d+\. )/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence !== "");
}

describe("the README", () => {
  it("has a section for what Tiehall is, the quickstart, the documentation and the licenses by directory", () => {
    const level2 = headings(readme).filter(({ level }) => level === 2).map(({ text }) => text);
    expect(level2).toEqual(expect.arrayContaining(["What Tiehall is", "Quickstart", "Documentation", "Licenses by directory"]));
    expect(level2.indexOf("What Tiehall is")).toBe(0);
    expect(part("What Tiehall is").replace(/\s+/g, " ")).toMatch(/Tiehall runs no LLM of its own/);
  });

  it("has its sections in the order a newcomer reads them (task 30.13)", () => {
    expect(headings(readme).filter(({ level }) => level === 2).map(({ text }) => text)).toEqual(SECTIONS);
  });

  it("shows, above its sections, the mark, the name and the film: its poster linked to it, or GitHub's player (task 30.13)", () => {
    const targets = links(header).map(({ target }) => target);
    expect(targets).toContain("docs/assets/brand/mark.svg");
    expect(header).toMatch(/<h1\b[^>]*>Tiehall<\/h1>|^# Tiehall$/m);
    if (!hasPlayer(header)) {
      expect(header).toMatch(new RegExp(`<a href="${FILM}"><img src="${POSTER}" alt="[^"]+"`));
      expect(links(header).filter(({ target, text }) => target === FILM && /^Watch\b/.test(text))).toHaveLength(1);
    }
  });

  it("plays the film in GitHub's player once the repository is public, where GP-19 of the checklist puts it (task 30.5)", () => {
    if (plan.get("30.5") === true) expect(hasPlayer(header)).toBe(true);
  });

  it("draws how it works and names the live hall (task 30.13)", () => {
    const blocks = fencedBlocks(part("How it works"));
    expect(blocks.map(({ info }) => info)).toContain("mermaid");
    expect(part("How it works")).toContain("`/hall`");
  });

  it("names each agent client the client-matrix log records a sign-in for, and links the pages on connecting agents (task 30.13)", () => {
    const clients = clientsWithASignIn();
    expect(clients).toEqual(expect.arrayContaining(["Claude Code", "Cursor", "Codex"]));
    const connect = part("Connect your agents");
    expect(clients.filter((client) => !connect.includes(client))).toEqual([]);
    expect(links(connect).map(({ target }) => target.split("#")[0])).toEqual(
      expect.arrayContaining(["docs/agents.md", "docs/claude-code-plugin.md", "docs/client-matrix/log.md", "docs/api.md"]),
    );
  });

  it("says the Jira Cloud mirror is not built yet, wherever it names Jira, while a task of group 25 is open (task 30.13)", () => {
    const jiraOpen = [...plan].some(([task, done]) => task.startsWith("25.") && !done);
    const jira = sentences().filter((sentence) => /\bJira\b/.test(sentence));
    expect(jira.length).toBeGreaterThan(0);
    if (jiraOpen) expect(jira.filter((sentence) => !sentence.includes("not built yet"))).toEqual([]);
  });

  it("says, until the first public release, that there is no release yet (task 30.13)", () => {
    if (plan.get("30.5") !== true) expect(part("Status").replace(/\s+/g, " ")).toContain("no release yet");
  });

  it("links the security policy and the trust docs from its security section, and says that an install sends no telemetry (task 30.13)", () => {
    const security = part("Security and privacy");
    expect(links(security).map(({ target }) => target.split("#")[0])).toEqual(expect.arrayContaining(["SECURITY.md", "docs/security-and-trust.md"]));
    expect(security.replace(/\s+/g, " ")).toMatch(/no telemetry/i);
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
