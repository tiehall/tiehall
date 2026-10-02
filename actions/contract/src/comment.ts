import type { ActionRuntime } from "./action.ts";

// The comment on the provider pull request when the provider team is the
// requester (contract-changes: The provider PR's author is the requester;
// design.md, Decisions this change rests on: D28 #75, #76; design.md, Design
// rules: Contract changes). When Tiehall answers that the provider team alone
// requests the changes of the requests a report opens, because the pull
// request's author is no member of the install, the Action says so on the pull
// request, with the workflow's own GITHUB_TOKEN, which the job needs
// `pull-requests: write` for. It posts one comment per pull request, marked
// with a hidden line, and on later runs updates that comment in place, so the
// pull request keeps one such comment. A workflow that checks several APIs on
// the pull request runs the Action once per API, so the comment holds a part
// per API, between hidden lines that name it: each run writes its own API's
// part, which shows its latest run, and keeps the others' parts as they were.
// A comment is the Action's own when it carries the mark and GitHub Actions'
// bot wrote it, so a comment someone else wrote with the mark is left alone.
// Runs for two APIs at the same moment, in jobs of their own, can each miss
// the other's part or comment; their next runs put it right. GitHub refusing the comment, or not
// answering, leaves the job as it is, with a warning: the comment is a
// courtesy, and the Action fails open.

/** The bot GitHub Actions comments as, with a workflow's GITHUB_TOKEN. */
const ACTIONS_BOT = "github-actions[bot]";

/** What the comment says: the API, the install, the provider team, and the run that wrote it. */
export interface RequesterComment {
  token: string;
  api: string;
  install: string;
  team: string;
  pullRequest: number;
  headSha: string;
}

/** The hidden line that marks the Action's comment on a pull request. */
export const COMMENT_MARK = "<!-- tiehall-contract-action -->";

/** An API's part of the comment, between the hidden lines that name the API, as an earlier run wrote it. */
const PART = /<!-- tiehall-contract-action api=([a-z0-9][a-z0-9._-]*) -->\r?\n[\s\S]*?<!-- \/tiehall-contract-action api=\1 -->/g;

/** The parts of the comment's body, by API. */
function partsOf(body: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const match of body.matchAll(PART)) parts.set(match[1] ?? "", match[0]);
  return parts;
}

/** The API's part of the comment, in Tiehall's words, with the run that wrote it. */
function partOf(comment: RequesterComment, env: ActionRuntime["env"]): string {
  const server = env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  const runId = env["GITHUB_RUN_ID"];
  const run = runId === undefined || runId === "" ? "the latest run" : `[run ${runId}](${server}/${repository}/actions/runs/${runId})`;
  return [
    `<!-- tiehall-contract-action api=${comment.api} -->`,
    `**Tiehall contract check: ${comment.api}**`,
    "",
    `The author of this pull request is not a member of the Tiehall install at ${comment.install}, so the provider team ${comment.team} is the requester of the contract-change requests this pull request's breaking changes to ${comment.api} open there.`,
    `The consuming teams' questions reach ${comment.team}'s inbox in Tiehall, where ${comment.team}'s members answer them.`,
    "",
    `Latest report: ${run}, on commit ${comment.headSha.slice(0, 7)}.`,
    `<!-- /tiehall-contract-action api=${comment.api} -->`,
  ].join("\n");
}

/** The comment's body: the mark, then each API's part, in the order of the APIs' names, this run's API's part new. */
function bodyOf(comment: RequesterComment, env: ActionRuntime["env"], earlier: string): string {
  const parts = partsOf(earlier);
  parts.set(comment.api, partOf(comment, env));
  const apis = [...parts.keys()].sort();
  return `${[COMMENT_MARK, ...apis.map((api) => parts.get(api) ?? "")].join("\n\n")}\n`;
}

/** Why a comment was not posted, in a sentence, or nothing when it was. */
export async function commentOnPullRequest(runtime: ActionRuntime, comment: RequesterComment): Promise<string | undefined> {
  const { env } = runtime;
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (comment.token === "") return "the job gave the Action no GitHub token to comment with, in its github-token input.";
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) return "the runner named no repository in GITHUB_REPOSITORY.";
  const api = (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${comment.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    "user-agent": "tiehall-contract-action",
  };
  const call = async (method: string, url: string, body?: unknown): Promise<Response | string> => {
    try {
      const answer = await runtime.fetch(new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      if (!answer.ok) return `GitHub answered HTTP ${answer.status}; the job needs the permission pull-requests: write to comment.`;
      return answer;
    } catch {
      return "GitHub's API could not be reached.";
    }
  };
  // The Action's own comment on the pull request, if an earlier run posted one.
  let ours: { id: number; body: string } | undefined;
  for (let page = 1; ours === undefined; page += 1) {
    const listed = await call("GET", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments?per_page=100&page=${page}`);
    if (typeof listed === "string") return listed;
    const comments = (await listed.json().catch(() => [])) as { id?: unknown; body?: unknown; user?: { login?: unknown } | null }[];
    if (!Array.isArray(comments)) return "GitHub's answer listed no comments.";
    const found = comments.find((each) => typeof each.body === "string" && each.body.includes(COMMENT_MARK) && each.user?.login === ACTIONS_BOT && typeof each.id === "number");
    if (found !== undefined) ours = { id: found.id as number, body: found.body as string };
    if (comments.length < 100) break;
  }
  const body = { body: bodyOf(comment, env, ours?.body ?? "") };
  const written =
    ours === undefined
      ? await call("POST", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments`, body)
      : await call("PATCH", `${api}/repos/${repository}/issues/comments/${ours.id}`, body);
  return typeof written === "string" ? written : undefined;
}
