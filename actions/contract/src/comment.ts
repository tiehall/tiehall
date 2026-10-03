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
// A comment is the Action's own when it carries the mark and the account the
// token acts as wrote it, so a comment someone else wrote with the mark is
// left alone. The job's github-token input may be the workflow's own
// GITHUB_TOKEN, which writes as GitHub Actions' bot, or a token of its own:
// for a person's token, GitHub's GET /user names its account; an
// installation token, GITHUB_TOKEN's kind and an App's, has no such account
// to read, and writes as a bot, which no person can write as, so its comment
// is the bot comment with the mark.
// Runs for several APIs at the same moment, in jobs of their own, write the
// one comment together, and GitHub writes a comment with no check that it is
// still as a run read it. So each run reads the comment again just before it
// writes it, and keeps every part it holds; then, a while after writing,
// longer than another run takes between reading the comment and writing it,
// reads it once more, and writes its part again when another run's write
// dropped it. Two runs that each found no comment and posted one leave two:
// the older one takes the newer one's parts, and the newer one is removed. A
// run writes the comment at most three times, then leaves it to the next run,
// with a warning. Two runs for the same API write the same part, and the
// README gives the job a concurrency group so that a newer push cancels the
// older run. GitHub refusing the comment, or not answering, leaves the job as
// it is, with a warning: the comment is a courtesy, and the Action fails open.

/** Whose comments a run may take for its own: the account a person's token acts as, or, for an installation token, any bot. */
type Author = { login: string } | { bot: true };

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

/** The run of the workflow that wrote an API's part, from its link, if the part names one. */
function runOf(part: string): number | undefined {
  const run = /\/actions\/runs\/(\d+)\)/.exec(part)?.[1];
  return run === undefined ? undefined : Number(run);
}

/** Whether `part` comes from a later run of the workflow than `than`. */
function later(part: string, than: string): boolean {
  const run = runOf(part);
  const other = runOf(than);
  return run !== undefined && other !== undefined && run > other;
}

/** Whether the comment holds this run's part for its API, as this run wrote it or as a later run did. */
function holds(body: string, api: string, part: string): boolean {
  const there = partsOf(body).get(api);
  return there !== undefined && (there === part || later(there, part));
}

/**
 * The comment's body: the mark, then each API's part, in the order of the APIs' names. It keeps the comment's parts,
 * takes the parts of the Action's other comments that it lacks or that a later run wrote, and puts in this run's part.
 */
function bodyOf(keeper: string, others: readonly string[], api: string, part: string): string {
  const parts = partsOf(keeper);
  for (const other of others) {
    for (const [name, text] of partsOf(other)) {
      const kept = parts.get(name);
      if (kept === undefined || later(text, kept)) parts.set(name, text);
    }
  }
  parts.set(api, part);
  const apis = [...parts.keys()].sort();
  return `${[COMMENT_MARK, ...apis.map((name) => parts.get(name) ?? "")].join("\n\n")}\n`;
}

/** How long a run waits after writing the comment before reading it again, at least: then up to as long again, at random. */
export const SETTLE_MS = 2_000;

/** How many times one run writes the comment before it leaves the comment to the next run. */
export const MAX_WRITES = 3;

/** A comment of the Action's own on the pull request. */
interface Ours {
  id: number;
  body: string;
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
  const UNREACHABLE = "GitHub's API could not be reached.";
  const refused = (answer: Response) => `GitHub answered HTTP ${answer.status}; the job needs the permission pull-requests: write to comment.`;
  /** GitHub's answer, or nothing when GitHub could not be reached. */
  const send = async (method: string, url: string, body?: unknown): Promise<Response | undefined> => {
    try {
      return await runtime.fetch(new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    } catch {
      return undefined;
    }
  };
  const call = async (method: string, url: string, body?: unknown): Promise<Response | string> => {
    const answer = await send(method, url, body);
    if (answer === undefined) return UNREACHABLE;
    return answer.ok ? answer : refused(answer);
  };
  // The account the token writes as: a person's token's, which GET /user names, or, for an installation token, a bot.
  const user = await call("GET", `${api}/user`);
  const self = typeof user === "string" ? undefined : ((await user.json().catch(() => undefined)) as { login?: unknown } | undefined)?.login;
  const author: Author = typeof self === "string" && self !== "" ? { login: self } : { bot: true };
  const wrote = (by: { login?: unknown; type?: unknown } | null | undefined) => ("login" in author ? by?.login === author.login : by?.type === "Bot");
  /** The Action's own comments on the pull request, oldest first, or why they could not be read. */
  const ourComments = async (): Promise<Ours[] | string> => {
    const ours: Ours[] = [];
    for (let page = 1; ; page += 1) {
      const listed = await call("GET", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments?per_page=100&page=${page}`);
      if (typeof listed === "string") return listed;
      const comments = (await listed.json().catch(() => [])) as { id?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } | null }[];
      if (!Array.isArray(comments)) return "GitHub's answer listed no comments.";
      for (const each of comments) {
        if (typeof each.body === "string" && each.body.includes(COMMENT_MARK) && wrote(each.user) && typeof each.id === "number") ours.push({ id: each.id, body: each.body });
      }
      if (comments.length < 100) return ours.sort((a, b) => a.id - b.id);
    }
  };
  const part = partOf(comment, env);
  const single = `${api}/repos/${repository}/issues/comments`;
  for (let writes = 0; ; writes += 1) {
    const ours = await ourComments();
    if (typeof ours === "string") return ours;
    const [keeper, ...others] = ours;
    if (writes > 0 && keeper !== undefined && others.length === 0 && holds(keeper.body, comment.api, part)) return undefined;
    if (writes === MAX_WRITES) return `other runs of the Action changed the comment at the same time, ${MAX_WRITES} times over; a later run updates it.`;
    if (keeper === undefined) {
      const posted = await call("POST", `${api}/repos/${repository}/issues/${comment.pullRequest}/comments`, { body: bodyOf("", [], comment.api, part) });
      if (typeof posted === "string") return posted;
    } else {
      // The comment as it is just before this run writes it, so the parts other runs wrote since the listing stay.
      const now = await send("GET", `${single}/${keeper.id}`);
      if (now === undefined) return UNREACHABLE;
      // A comment removed since the listing (404) is written no more: the next listing finds what is left.
      if (!now.ok && now.status !== 404) return refused(now);
      if (now.ok) {
        const read = ((await now.json().catch(() => undefined)) as { body?: unknown } | undefined)?.body;
        const body = bodyOf(typeof read === "string" ? read : keeper.body, others.map(({ body: other }) => other), comment.api, part);
        const patched = await send("PATCH", `${single}/${keeper.id}`, { body });
        if (patched === undefined) return UNREACHABLE;
        if (!patched.ok && patched.status !== 404) return refused(patched);
        // The Action's newer comments, whose parts the comment now holds.
        for (const other of patched.ok ? others : []) {
          const removed = await send("DELETE", `${single}/${other.id}`);
          if (removed === undefined) return UNREACHABLE;
          if (!removed.ok && removed.status !== 404) return refused(removed);
        }
      }
    }
    await runtime.sleep(SETTLE_MS + Math.floor(Math.random() * SETTLE_MS));
  }
}
