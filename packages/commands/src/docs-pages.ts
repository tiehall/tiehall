import { builtFrom } from "./running-version.ts";
import type { Environment } from "./settings.ts";

// The pages of Tiehall's docs that the admin UI links (task 28.6;
// agent-surfaces: Four agent surfaces; contract-changes: The contract Action;
// design.md, Where the specs leave room: the admin UI's layout). The docs are
// Markdown pages in the public repository's docs/ folder, which the image does
// not carry, so the admin page links each page as the repository shows it, at
// the docs of the running version: the release's version tag, or a
// development build's commit, or main for a development build that names none
// (running-version.ts). A modified server's TIEHALL_SOURCE_URL names where
// its source is, which need not lay its docs out as the public repository
// does, so the docs links keep to the public repository the image was built
// from, at the version the server is built on.

export interface DocsPage {
  /** The page in the repository, under docs/. */
  path: string;
  /** What the admin page calls it. */
  title: string;
}

/** The docs pages the admin page links, in the order it lists them. */
export const DOCS_PAGES: readonly DocsPage[] = [
  { path: "docs/agents.md", title: "Agents: the four ways in, personal access tokens and bot users" },
  { path: "docs/claude-code-plugin.md", title: "The Claude Code plugin, its skill and its hooks" },
  { path: "docs/requester-loop.md", title: "The requester loop, commitments and email" },
  { path: "docs/people-and-teams.md", title: "People and teams: roles, invites, teams and the sign-in policy" },
  { path: "docs/github-and-jira.md", title: "GitHub and Jira: installations, webhook and polling modes, and mirrors" },
  { path: "docs/contract-changes.md", title: "Contract changes: APIs, the consumer map and the contract Action" },
  { path: "docs/activity-log.md", title: "The activity log" },
  { path: "docs/install.md", title: "Installing and running Tiehall" },
  { path: "docs/security-and-trust.md", title: "Security and trust" },
];

export interface DocsLink {
  title: string;
  url: string;
}

/** Each docs page, linked at the running version's docs in the public repository the image was built from. */
export function docsLinks(env: Environment): DocsLink[] {
  const { repository, ref } = builtFrom(env);
  return DOCS_PAGES.map(({ path, title }) => ({ title, url: `${repository}/blob/${ref ?? "main"}/${path}` }));
}
