import type { Author, GitHubWorld, StubAccount, StubApp, StubComment, StubInstallation, StubIssue, StubPullRequest, StubRepo, StubUser } from "./world.ts";
import { fullNameOf } from "./world.ts";

// The JSON GitHub's REST API answers with, for each kind of record the stub
// keeps, in the shapes GitHub documents (a subset of each object's fields).
// URLs point at the stub, so a client that follows them stays on it.

export interface Urls {
  /** Where the stub serves api.github.com. */
  api: string;
  /** Where the stub serves github.com. */
  web: string;
}

export function accountJson(urls: Urls, account: StubAccount): Record<string, unknown> {
  const path = account.type === "User" ? "users" : "orgs";
  return {
    login: account.login,
    id: account.id,
    node_id: account.nodeId,
    avatar_url: `${urls.web}/avatars/${account.id}`,
    url: `${urls.api}/${path}/${account.login}`,
    html_url: `${urls.web}/${account.login}`,
    type: account.type,
    site_admin: false,
  };
}

export function userJson(urls: Urls, user: StubUser): Record<string, unknown> {
  const publicEmail = user.emails.find((email) => email.visibility === "public" && email.primary)?.email ?? null;
  return {
    ...accountJson(urls, user),
    name: user.name,
    company: null,
    blog: "",
    location: null,
    email: publicEmail,
    hireable: null,
    bio: null,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: user.createdAt,
    updated_at: user.createdAt,
  };
}

export function orgJson(urls: Urls, account: StubAccount): Record<string, unknown> {
  return {
    login: account.login,
    id: account.id,
    node_id: account.nodeId,
    url: `${urls.api}/orgs/${account.login}`,
    avatar_url: `${urls.web}/avatars/${account.id}`,
    description: null,
  };
}

export function botJson(urls: Urls, app: StubApp): Record<string, unknown> {
  const login = `${app.slug}[bot]`;
  return {
    login,
    id: app.botId,
    node_id: `BOT_${app.botId}`,
    avatar_url: `${urls.web}/avatars/${app.botId}`,
    url: `${urls.api}/users/${encodeURIComponent(login)}`,
    html_url: `${urls.web}/apps/${app.slug}`,
    type: "Bot",
    site_admin: false,
  };
}

export function authorJson(urls: Urls, author: Author): Record<string, unknown> {
  return author.kind === "user" ? accountJson(urls, author.user) : botJson(urls, author.app);
}

/** GET /app, and the base of the manifest conversion's answer. */
export function appJson(urls: Urls, app: StubApp): Record<string, unknown> {
  return {
    id: app.id,
    slug: app.slug,
    node_id: app.nodeId,
    client_id: app.clientId,
    owner: accountJson(urls, app.owner),
    name: app.name,
    description: app.description,
    external_url: app.url,
    html_url: `${urls.web}/apps/${app.slug}`,
    created_at: app.createdAt,
    updated_at: app.updatedAt,
    permissions: sortedPermissions(app.permissions),
    events: [...app.events],
  };
}

/**
 * The answer to POST /app-manifests/{code}/conversions: exactly the fields the
 * spike recorded (client_id, client_secret, created_at, description, events,
 * external_url, html_url, id, name, node_id, owner, pem, permissions, slug,
 * updated_at, webhook_secret), with `webhook_secret` null for an App without
 * a webhook.
 */
export function conversionJson(urls: Urls, app: StubApp): Record<string, unknown> {
  return {
    ...appJson(urls, app),
    client_secret: app.clientSecret,
    webhook_secret: app.webhookSecret,
    pem: app.pem,
  };
}

export function installationJson(urls: Urls, world: GitHubWorld, installation: StubInstallation): Record<string, unknown> {
  const app = world.apps.get(installation.appId)!;
  return {
    id: installation.id,
    client_id: app.clientId,
    account: accountJson(urls, installation.account),
    repository_selection: installation.selection,
    access_tokens_url: `${urls.api}/app/installations/${installation.id}/access_tokens`,
    repositories_url: `${urls.api}/installation/repositories`,
    html_url: `${urls.web}/${installation.account.type === "User" ? "settings" : `organizations/${installation.account.login}/settings`}/installations/${installation.id}`,
    app_id: app.id,
    app_slug: app.slug,
    target_id: installation.account.id,
    target_type: installation.account.type,
    permissions: sortedPermissions(installation.permissions),
    events: [...installation.events],
    created_at: installation.createdAt,
    updated_at: installation.updatedAt,
    single_file_name: null,
    has_multiple_single_files: false,
    single_file_paths: [],
    suspended_by: installation.suspendedBy === null ? null : accountJson(urls, installation.suspendedBy),
    suspended_at: installation.suspendedAt,
  };
}

export function repoJson(urls: Urls, repo: StubRepo): Record<string, unknown> {
  const fullName = fullNameOf(repo);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: accountJson(urls, repo.owner),
    html_url: `${urls.web}/${fullName}`,
    description: null,
    fork: false,
    url: `${urls.api}/repos/${fullName}`,
    default_branch: "main",
    visibility: repo.private ? "private" : "public",
  };
}

/** The short form of a repository in installation webhooks. */
export function repoSummaryJson(repo: StubRepo): Record<string, unknown> {
  return { id: repo.id, node_id: repo.nodeId, name: repo.name, full_name: fullNameOf(repo), private: repo.private };
}

export function pullRequestJson(urls: Urls, pr: StubPullRequest): Record<string, unknown> {
  const fullName = fullNameOf(pr.repo);
  const repo = repoJson(urls, pr.repo);
  const owner = accountJson(urls, pr.repo.owner);
  return {
    url: `${urls.api}/repos/${fullName}/pulls/${pr.number}`,
    id: pr.id,
    node_id: pr.nodeId,
    html_url: `${urls.web}/${fullName}/pull/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: accountJson(urls, pr.author),
    body: pr.body,
    labels: [],
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    draft: pr.draft,
    head: { label: `${pr.repo.owner.login}:${pr.head.ref}`, ref: pr.head.ref, sha: pr.head.sha, user: owner, repo },
    base: { label: `${pr.repo.owner.login}:${pr.base.ref}`, ref: pr.base.ref, sha: pr.base.sha, user: owner, repo },
    author_association: "MEMBER",
    merged: pr.merged,
  };
}

export function issueJson(urls: Urls, world: GitHubWorld, issue: StubIssue | StubPullRequest): Record<string, unknown> {
  const fullName = fullNameOf(issue.repo);
  const base = {
    url: `${urls.api}/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${urls.api}/repos/${fullName}`,
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    locked: false,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    body: issue.body,
    author_association: "NONE",
  };
  if (issue.kind === "pull_request") {
    return {
      ...base,
      html_url: `${urls.web}/${fullName}/pull/${issue.number}`,
      user: accountJson(urls, issue.author),
      labels: [],
      state: issue.state,
      state_reason: null,
      assignee: null,
      assignees: [],
      comments: 0,
      pull_request: {
        url: `${urls.api}/repos/${fullName}/pulls/${issue.number}`,
        html_url: `${urls.web}/${fullName}/pull/${issue.number}`,
        merged_at: issue.mergedAt,
      },
    };
  }
  const assignees = issue.assigneeIds.map((id) => world.accountById(id)).filter((account): account is StubAccount => account !== undefined);
  return {
    ...base,
    html_url: `${urls.web}/${fullName}/issues/${issue.number}`,
    user: authorJson(urls, issue.author),
    labels: issue.labels.map((name) => labelJson(urls, issue.repo, name)),
    state: issue.state,
    state_reason: issue.stateReason,
    assignee: assignees[0] === undefined ? null : accountJson(urls, assignees[0]),
    assignees: assignees.map((account) => accountJson(urls, account)),
    comments: issue.comments.length,
  };
}

export function labelJson(urls: Urls, repo: StubRepo, name: string): Record<string, unknown> {
  return {
    id: labelId(repo, name),
    name,
    color: "ededed",
    default: false,
    description: null,
    url: `${urls.api}/repos/${fullNameOf(repo)}/labels/${encodeURIComponent(name)}`,
  };
}

function labelId(repo: StubRepo, name: string): number {
  let hash = repo.id;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  return hash;
}

export function commentJson(urls: Urls, issue: StubIssue | StubPullRequest, comment: StubComment): Record<string, unknown> {
  const fullName = fullNameOf(issue.repo);
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${urls.api}/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `${urls.web}/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${urls.api}/repos/${fullName}/issues/${issue.number}`,
    body: comment.body,
    user: authorJson(urls, comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: "NONE",
  };
}

function sortedPermissions(permissions: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)));
}
