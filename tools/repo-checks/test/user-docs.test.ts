import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headings, linkProblems, links, repositoryFiles, section } from "../src/markdown.ts";

// The user and admin docs (task 28.6; agent-surfaces: Four agent surfaces;
// contract-changes: The contract Action; contract-changes: The Action reports
// to the install its workflow names; teams-and-roles: What admins and members
// may do; agent-safety: The documented limit of the confirmation step;
// activity-log: What the activity log does not prove). Each topic has a page
// under docs/, with a section for it that says what a person or an admin needs
// to know, and the admin UI links each page: the admin page lists every page
// of DOCS_PAGES in packages/commands/src/docs-pages.ts, which the commands'
// own tests render (running-version-web.test.ts, docs-pages.test.ts). The
// check finds each topic's section and what it must say, every link of the
// pages resolving, and each page among the pages the admin UI links.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The pages the admin UI links, as packages/commands/src/docs-pages.ts lists them. */
const linkedFromAdminUi = [...read("packages/commands/src/docs-pages.ts").matchAll(/path: "(docs\/[a-z-]+\.md)"/g)].map((match) => match[1] ?? "");

/** The schemes that are never an app's own, in their order, as EXCLUDED_SCHEMES in packages/commands/src/agent-clients.ts lists them. */
const excludedSchemes = [...(/export const EXCLUDED_SCHEMES[^=]*= new Set\(\[([^\]]*)\]\)/.exec(read("packages/commands/src/agent-clients.ts"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
  (match) => match[1] ?? "",
);

interface Topic {
  /** The topic as the task names it. */
  topic: string;
  page: string;
  /** The page's level-2 section that covers the topic. */
  heading: string;
  /** What the section must say, each as it says it once its white space is made single spaces. */
  says: string[];
}

const TOPICS: Topic[] = [
  {
    topic: "the four agent surfaces",
    page: "docs/agents.md",
    heading: "The four ways in",
    says: ["`TIEHALL_URL/mcp`", "tools only", "`tiehall login <url>`", "Claude Code plugin", "request URL", "`.md`", "`.json`", "`get_request`", "`tiehall get`"],
  },
  {
    topic: "the four agent surfaces",
    page: "docs/agents.md",
    heading: "Signing in",
    says: [
      "consent screen",
      "Client ID Metadata Document",
      "Dynamic Client Registration",
      "`TIEHALL_CLIENT_METADATA_FETCH=off`",
      "`requests:read`",
      "`/tokens`",
      // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (15), as the maintainer answered on
      // 2026-10-15 (task 27.5).
      "Cursor and clients built on VS Code sign in through Dynamic Client Registration",
      "`cursor://anysphere.cursor-mcp/oauth/callback`",
      // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (15), as the maintainer answered on
      // 2026-10-16 (task 27.6).
      "and the place it will send you back to, with every other place the client registered",
      "`https://www.cursor.com/agents/mcp/oauth/callback` beside `http://localhost:8787/callback`",
      "a client that registers only `https:` URIs counts as a web application",
      "the install refuses it and names that URI",
      "an `https:` URI on a host other than localhost and the loopback addresses",
      "or a redirect URI with a fragment or user information",
    ],
  },
  {
    topic: "the plugin and skill",
    page: "docs/claude-code-plugin.md",
    heading: "Installing the plugin",
    says: [
      "`TIEHALL_URL`",
      "claude plugin marketplace add muhmmdcnkl/Tiehall",
      "claude plugin install tiehall@tiehall",
      "#v1.3.0",
      "claude plugin marketplace remove tiehall",
      "claude --plugin-dir packages/claude-plugin",
      "claude mcp add --transport http tiehall",
      "`tiehall` CLI",
    ],
  },
  {
    topic: "the plugin and skill",
    page: "docs/claude-code-plugin.md",
    heading: "The skill",
    says: ["Agent Skills format", "`whats_new`", "fenced", "`whoami`"],
  },
  {
    topic: "the plugin and skill",
    page: "docs/claude-code-plugin.md",
    heading: "The hooks",
    // The hooks' cursor and the upgrade line: decisions-from-groups-15-28: design.md, Decisions this change rests on:
    // D55 (44), (52).
    says: [
      "SessionStart",
      "Stop",
      "`asyncRewake`",
      "30 minutes",
      "exit code 2",
      "`tiehall watch`",
      "acknowledge",
      "the hooks no longer announce it",
      "prints one line that asks you to run `npm install --global tiehall@latest`",
      // findings-from-claude-code-run: design.md, Findings: F1 (3).
      "runs its hooks in every Claude Code session of yours on the machine",
      "the Claude desktop app's Code tab",
      "only in that project's sessions",
    ],
  },
  {
    topic: "PATs and bot users",
    page: "docs/agents.md",
    heading: "Personal access tokens and bot users",
    says: ["`th_pat_`", "90 days", "`/tokens`", "confirmation step", "`Authorization`", "bot user", "`/admin/personal-access-tokens`", "14 and 3 days"],
  },
  {
    topic: "the requester loop",
    page: "docs/requester-loop.md",
    heading: "Pull is the contract",
    says: [
      "`whats_new`",
      "`tiehall updates`",
      "`/inbox`",
      "acknowledge",
      "`GET /api/v1/events/wait`",
      "60 seconds",
      // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (43); findings-from-claude-code-run:
      // design.md, Findings: F2 (4).
      "What you did yourself is not news to you",
      "leave out what any of your agents did",
      "keep what you did in the web UI",
      "the web inbox's feed and the daily digest leave out everything you did",
      // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (44).
      "starts where your web inbox is",
    ],
  },
  {
    topic: "the requester loop",
    page: "docs/requester-loop.md",
    heading: "Commitments and the confirmation step",
    says: [
      "An agent that drives your own signed-in browser can click confirm on a review page",
      "can post a message from the web UI that clears a request's `needs_human` flag",
      "Do not give a browser-driving agent a browser profile that is signed in to Tiehall",
      "Receipts, the undo window and keeping the confirm URL away from models reduce this risk; they do not remove it",
      "15 minutes",
      "7 days",
    ],
  },
  {
    topic: "email",
    page: "docs/requester-loop.md",
    heading: "Email",
    says: [
      "SMTP",
      "right away",
      "daily digest",
      "`/settings/email`",
      "cannot turn off",
      "primary verified email address",
      // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (48); design.md, Technical decisions: T7.
      "at most the 7 latest",
      "first and last day it covers",
      "Tiehall's own fixed words",
    ],
  },
  {
    topic: "teams, roles, invites and the sign-in policy",
    page: "docs/people-and-teams.md",
    heading: "Roles",
    says: ["`admin`", "`member`", "at least one admin", "`admin grant <github-login>`", "`/members`"],
  },
  {
    topic: "teams, roles, invites and the sign-in policy",
    page: "docs/people-and-teams.md",
    heading: "Who may sign in, and the sign-in policy",
    says: ["GitHub", "connected installation", "invite", "`/admin/sign-in-policy`", "invited people only", "403", "leave"],
  },
  {
    topic: "teams, roles, invites and the sign-in policy",
    page: "docs/people-and-teams.md",
    heading: "Invites",
    says: ["`/admin/invites`", "GitHub username", "7 days", "revoke"],
  },
  {
    topic: "teams, roles, invites and the sign-in policy",
    page: "docs/people-and-teams.md",
    heading: "Teams",
    says: ["`/admin/teams`", "2 to 10", "intake", "required fields"],
  },
  {
    topic: "GitHub",
    page: "docs/github-and-jira.md",
    heading: "GitHub",
    says: ["`/admin/github`", "confirmation step", "covered repositories", "private key"],
  },
  {
    topic: "webhook and polling modes",
    page: "docs/github-and-jira.md",
    heading: "Webhook and polling modes",
    says: ["webhook mode", "polling mode", "60 seconds", "2 minutes", "15 minutes", "Webhook secret"],
  },
  {
    topic: "the mirrors",
    page: "docs/github-and-jira.md",
    heading: "Mirrors",
    says: ["intake repository", "on claim", "summary", "Retry", "close on merge"],
  },
  {
    topic: "APIs",
    page: "docs/contract-changes.md",
    heading: "Registering an API",
    says: ["`/admin/apis`", "provider team", "repository", "confirmation step", "workflow", "it is a new API, which the consuming teams declare again"],
  },
  {
    topic: "the consumer map",
    page: "docs/contract-changes.md",
    heading: "The consumer map",
    says: ["`/teams/apis`", "90 days", "stale", "WARN", "recorded in the activity log"],
  },
  {
    topic: "the Action with its runner notes and SHA pinning",
    page: "docs/contract-changes.md",
    heading: "The contract Action",
    says: ["commit SHA", "version comment", "release's notes", "GitHub-hosted runner", "reachable from the internet", "self-hosted runner inside", "`id-token: write`", "fails open"],
  },
  {
    topic: "the activity log",
    page: "docs/activity-log.md",
    heading: "Reading the log",
    says: ["`/admin/activity-log`", "security events", "admins", "90 days"],
  },
  {
    topic: "the activity log",
    page: "docs/activity-log.md",
    heading: "Exporting the log",
    says: ["JSONL", "confirmation step", "security event"],
  },
  {
    topic: "the activity log",
    page: "docs/activity-log.md",
    heading: "What the activity log does not prove",
    says: [
      "The activity log is not tamper-evident",
      "whoever holds the database owner role or controls the host can change or delete events without the change being detectable",
      "A tamper-evident log, with a hash chain anchored outside the install, is planned as a later addition",
    ],
  },
];

const pages = [...new Set(TOPICS.map(({ page }) => page))];

describe("the user and admin docs", () => {
  it.each(TOPICS.map((topic) => [`${topic.topic}: ${topic.page}, "${topic.heading}"`, topic] as const))("cover %s", (_name, { page, heading, says }) => {
    const markdown = read(page);
    expect(
      headings(markdown)
        .filter(({ level }) => level === 2)
        .map(({ text }) => text),
    ).toContain(heading);
    const text = (section(markdown, heading) ?? "").replace(/\s+/g, " ");
    expect(says.filter((phrase) => !text.includes(phrase))).toEqual([]);
  });

  it("are each a page the admin UI links, with a title of their own", () => {
    for (const page of pages) {
      expect(linkedFromAdminUi, page).toContain(page);
      expect(read(page).split("\n")[0], page).toMatch(/^# \S/);
    }
  });

  it("link only what resolves", () => {
    const files = repositoryFiles(root);
    for (const page of pages) expect(linkProblems(root, page, files), page).toEqual([]);
  });

  it("name the admin pages each admin action is on (github-layer-hardening 1.5)", () => {
    const people = read("docs/people-and-teams.md");
    for (const path of ["/members", "/admin/invites", "/admin/teams", "/admin/sign-in-policy"]) expect(people, path).toContain(`\`${path}\``);
    expect(read("docs/github-and-jira.md")).toContain("`/admin/github`");
    // agent-safety: Agent writes are limited per token and budgeted per install: the admin page holds the budget's form.
    expect(read("docs/agents.md").replace(/\s+/g, " ")).toMatch(/agent writes a UTC day for the whole install by default, which an admin can change on the admin page, `\/admin`, under Agent writes/);
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (15). The rule keeps out the schemes it
  // lists, and a scheme that reaches a program by an address but is not listed, such as `webcal:`, passes when it has
  // an app's shape, so the docs name the list as the code holds it rather than every scheme of a kind.
  it("name exactly the schemes that never count as an app's own, as the registration step excludes them", () => {
    expect(excludedSchemes).toContain("mailto");
    const named = excludedSchemes.map((scheme) => `\`${scheme}:\``);
    const list = `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
    const text = (section(read("docs/agents.md"), "Signing in") ?? "").replace(/\s+/g, " ");
    expect(text).toContain(`these schemes never count as an app's own: ${list}.`);
    expect(text).not.toMatch(/reaches a program by an address[^.]*never counts/);
  });

  it("point to the Action's own README for its inputs", () => {
    expect(links(section(read("docs/contract-changes.md"), "The contract Action") ?? "").map(({ target }) => target)).toContain("../actions/contract/README.md");
  });

  it("show a command the CLI takes for attaching a diff by hand: --attach with --pull-request and --if-match", () => {
    const part = section(read("docs/contract-changes.md"), "Attaching a diff by hand") ?? "";
    const command = /^tiehall contract diff .+$/m.exec(part)?.[0] ?? "";
    // packages/cli/src/contract-diff.ts refuses --attach without --pull-request; the install answers 428 without If-Match.
    for (const option of ["--attach", "--pull-request", "--if-match"]) expect(command, option).toContain(option);
    expect(part).toContain("`tiehall get FE-142`");
  });

  // The Jira Cloud connection, its bot account and its mirror wait for group 25, which waits for the founder's Jira
  // spikes 1.7 and 1.8; the page says so until then, and this case turns plain with tasks 25.1 to 25.6.
  it.todo("cover the Jira Cloud connection through a dedicated bot account's API token, its expiry reminders, its webhooks and its mirror (tasks 25.1 to 25.6)");
});
