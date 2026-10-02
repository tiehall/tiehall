import type { ActionRuntime } from "./action.ts";

// The comment on the provider pull request when the provider team is the
// requester (contract-changes: The provider PR's author is the requester;
// design.md, Decisions this change rests on: D28 #75, #76; design.md, Design
// rules: Contract changes). When Tiehall answers that the provider team alone
// requests the changes of the requests a report opens, because the pull
// request's author is no member of the install, the Action says so on the pull
// request, with the workflow's own GITHUB_TOKEN, which the job needs
// `pull-requests: write` for. It posts one comment per pull request and API,
// marked with a hidden line, and on later runs updates that comment in place,
// so it always shows the latest run. A comment is the Action's own when it
// carries the mark and GitHub Actions' bot wrote it, so a comment someone else
// wrote with the mark is left alone. GitHub refusing the comment, or not
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

/** The hidden line that marks the Action's comment for an API. */
export function commentMark(api: string): string {
  return `<!-- tiehall-contract-action: ${api} -->`;
}

/** The comment's body, in Tiehall's words, with the run that wrote it. */
function bodyOf(comment: RequesterComment, env: ActionRuntime["env"]): string {
  const server = env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  const runId = env["GITHUB_RUN_ID"];
  const run = runId === undefined || runId === "" ? "the latest run" : `[run ${runId}](${server}/${repository}/actions/runs/${runId})`;
  return [
    commentMark(comment.api),
    `**Tiehall contract check: ${comment.api}**`,
    "",
    `The author of this pull request is not a member of the Tiehall install at ${comment.install}, so the provider team ${comment.team} is the requester of the contract-change requests this pull request's breaking changes to ${comment.api} open there.`,
    `The consuming teams' questions reach ${comment.team}'s inbox in Tiehall, where ${comment.team}'s members answer them.`,
    "",
    `Latest report: ${run}, on commit ${comment.headSha.slice(0, 7)}.`,
    "",
  ].join("\n");
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
  // The Action's own comment for the API, if an earlier run posted one.
  const mark = commentMark(comment.api);
  let ours: number | undefined;
  for (let page = 1; ours === undefined; page += 1) {
    const listed = await call("GET", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments?per_page=100&page=${page}`);
    if (typeof listed === "string") return listed;
    const comments = (await listed.json().catch(() => [])) as { id?: unknown; body?: unknown; user?: { login?: unknown } | null }[];
    if (!Array.isArray(comments)) return "GitHub's answer listed no comments.";
    const found = comments.find((each) => typeof each.body === "string" && each.body.includes(mark) && each.user?.login === ACTIONS_BOT && typeof each.id === "number");
    if (found !== undefined) ours = found.id as number;
    if (comments.length < 100) break;
  }
  const body = { body: bodyOf(comment, env) };
  const written =
    ours === undefined
      ? await call("POST", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments`, body)
      : await call("PATCH", `${api}/repos/${repository}/issues/comments/${ours}`, body);
  return typeof written === "string" ? written : undefined;
}
