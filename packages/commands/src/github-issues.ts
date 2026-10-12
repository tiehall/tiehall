import type { Database } from "@tiehall/db";
import { z } from "zod";
import { installationCovering } from "./contract-requesters.ts";
import { gitHubUnavailable, GitHubUnavailableError, pagesOf, statusOfCall, type GitHubClient } from "./github-client.ts";
import type { GitHubAppAccess } from "./github-installations.ts";
import { LOGGABLE } from "./log.ts";
import { MirrorIssueGoneError } from "./mirror-failures.ts";
import type { MirrorSummary } from "./mirror-texts.ts";
import type { CloseReason, IssueNow, IssueUpdate, MirrorProjection, TrackerAccount, TrackerAdapter } from "./mirrors.ts";
import { withOrg } from "./with-org.ts";

// GitHub Issues as a mirror tracker (tracker-mirrors: A mirror is a
// projection of the request; tracker-mirrors: GitHub writes appear as the
// App's bot; tracker-mirrors: Covered repositories follow each connected
// installation; agent-access: Outbound calls use Tiehall's own credentials;
// design.md, Technical decisions: T16). The adapter the mirror module
// (mirrors.ts) writes a team's mirror issues through, in the team's intake
// repository, which its mapping names by GitHub's id. Every call goes to
// GitHub as the connected installation of the install's GitHub App that
// covers the repository now, neither suspended nor deleted, with that
// installation's token, so every issue, comment, label and state change
// Tiehall writes appears as the App's bot. A repository no such installation
// covers is written to no more: the call fails, as the job does, until an
// installation covers it again.
//
// A mirror issue's body is the summary Tiehall wrote, then an HTML comment
// that GitHub's Markdown does not show and that names the mirror's marker:
// the create carries it, and a retried create finds the issue by it among the
// repository's issues made since the mirror's row was written, newest first.
// The state label is added and the one Tiehall set before taken off, so the
// labels people add stay. A comment Tiehall adds ends with a comment of the
// same kind that names its own marker, by which a retried comment is found
// among the issue's comments. The issue's state is set with GitHub's state
// and state_reason: closed as completed or not_planned, or open again. A
// write to an issue, or the read of its comments, that GitHub answers with
// 404 or 410, as for an issue someone deleted or moved out of the App's
// reach, throws MirrorIssueGoneError, which the mirror job marks the mirror
// gone for (decisions-from-groups-15-28: design.md, Technical decisions:
// T10); any other failure is GitHub being unavailable.

/** The line a mirror issue's body ends with, which names its marker; GitHub's Markdown does not show it. */
export function markerLine(marker: string): string {
  if (!/^[0-9a-f-]{36}$/.test(marker)) throw new TypeError("A mirror's marker is a UUID.");
  return `<!-- tiehall:mirror ${marker} -->`;
}

/** A mirror issue's body: the summary's paragraphs, then the marker's line. */
export function issueBody(summary: MirrorSummary, marker: string): string {
  return [...summary.paragraphs, markerLine(marker)].join("\n\n");
}

/** The line a comment Tiehall adds ends with, which names the comment's own marker. */
export function commentMarkerLine(marker: string): string {
  if (!/^[0-9a-f-]{36}$/.test(marker)) throw new TypeError("A comment's marker is a UUID.");
  return `<!-- tiehall:mirror-comment ${marker} -->`;
}

/** The team's intake repository is covered by no working connected installation now, so its mirror issue is not written. */
export class MirrorPlaceUnavailableError extends Error {
  override name = "MirrorPlaceUnavailableError";
  readonly [LOGGABLE] = true;
  constructor() {
    super("No connected installation of the install's GitHub App covers the team's intake repository now, so its mirror issue is not written.");
  }
}

const ACCOUNT = z.looseObject({ id: z.number().int().positive(), login: z.string().min(1) });

const ISSUE = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  assignees: z.array(ACCOUNT).nullable().optional(),
  closed_by: ACCOUNT.nullable().optional(),
  pull_request: z.unknown().optional(),
});

const ISSUES = z.array(ISSUE);

const COMMENTS = z.array(z.looseObject({ body: z.string().nullable().optional() }));

/** Why GitHub says a closed issue was closed: completed unless it names another reason Tiehall tells apart. */
function closeReasonOf(stateReason: string | null | undefined): CloseReason {
  return stateReason === "not_planned" ? "not_planned" : stateReason === "duplicate" ? "duplicate" : "completed";
}

/** The error of a call about one mirror issue: gone when GitHub answers 404 or 410, as for an issue it no longer has; unavailable otherwise. */
function issueCallFailed(what: string, error: unknown): Error {
  const status = statusOfCall(error);
  return status === 404 || status === 410 ? new MirrorIssueGoneError("GitHub") : gitHubUnavailable(what, error);
}

function accountOf(account: z.output<typeof ACCOUNT>): TrackerAccount {
  return { id: String(account.id), login: account.login };
}

type Installation = ReturnType<GitHubClient["installation"]>;

export interface GitHubIssuesOptions {
  /** The install's App, which calls GitHub as its installations. */
  app: GitHubAppAccess;
  /** The app's database, as the app role, where the covering installation is read. */
  database: Database;
}

/** The adapter that writes mirror issues to GitHub Issues, as the install's App. */
export function createGitHubIssues({ app, database }: GitHubIssuesOptions): TrackerAdapter {
  /** The intake repository a mapping names, by GitHub's id, as the installation that covers it now reaches it. */
  async function repositoryOf(target: string): Promise<{ octokit: Installation; owner: string; repo: string }> {
    const repositoryId = Number(target);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new TypeError("A GitHub mirror's place is a repository's id.");
    const covering = await withOrg(database, (context) => installationCovering(context, app.appId, repositoryId), { readOnly: true });
    if (covering === undefined) throw new MirrorPlaceUnavailableError();
    const [owner = "", repo = ""] = covering.fullName.split("/");
    return { octokit: app.client.installation(covering.installationId), owner, repo };
  }

  return {
    tracker: "github",

    async findCreated(target, marker, since) {
      const { octokit, owner, repo } = await repositoryOf(target);
      const line = markerLine(marker);
      try {
        for await (const page of pagesOf(octokit, "GET /repos/{owner}/{repo}/issues", {
          owner,
          repo,
          state: "all",
          since: since.toISOString(),
          sort: "created",
          direction: "desc",
          per_page: 100,
        })) {
          const issues = ISSUES.safeParse(page);
          if (!issues.success) throw new GitHubUnavailableError("GitHub's answer to the listing of an intake repository's issues lists no issues.");
          const found = issues.data.find((issue) => issue.pull_request === undefined && (issue.body ?? "").includes(line));
          if (found !== undefined) return String(found.number);
          // Newest first: once the page's last issue was made before the create began, no later page holds it.
          const last = issues.data.at(-1);
          if (last === undefined || Date.parse(last.created_at) < since.getTime()) return undefined;
        }
      } catch (error) {
        throw gitHubUnavailable("the listing of an intake repository's issues", error);
      }
      return undefined;
    },

    async createIssue(target, projection: MirrorProjection, marker) {
      const { octokit, owner, repo } = await repositoryOf(target);
      let data: unknown;
      try {
        ({ data } = await octokit.request("POST /repos/{owner}/{repo}/issues", {
          owner,
          repo,
          title: projection.title,
          body: issueBody(projection.summary, marker),
          labels: [projection.label],
        }));
      } catch (error) {
        throw gitHubUnavailable("the creation of a mirror issue", error);
      }
      const created = ISSUE.safeParse(data);
      if (!created.success) throw new GitHubUnavailableError("GitHub's answer to the creation of a mirror issue names no issue.");
      return String(created.data.number);
    },

    async updateIssue(target, issue, marker, update: IssueUpdate) {
      const { octokit, owner, repo } = await repositoryOf(target);
      const issue_number = Number(issue);
      try {
        if (update.title !== undefined || update.summary !== undefined || update.state !== undefined) {
          const state = update.state;
          await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
            owner,
            repo,
            issue_number,
            ...(update.title === undefined ? {} : { title: update.title }),
            ...(update.summary === undefined ? {} : { body: issueBody(update.summary, marker) }),
            ...(state === undefined ? {} : state.open ? { state: "open" } : { state: "closed", state_reason: state.closeReason ?? "completed" }),
          });
        }
        if (update.label !== undefined) {
          await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner, repo, issue_number, labels: [update.label.add] });
          const remove = update.label.remove;
          if (remove !== null && remove !== update.label.add) {
            try {
              await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner, repo, issue_number, name: remove });
            } catch (error) {
              // A label someone took off already is gone.
              if (statusOfCall(error) !== 404) throw error;
            }
          }
        }
      } catch (error) {
        throw issueCallFailed("an update of a mirror issue", error);
      }
    },

    async addComment(target, issue, text, marker) {
      const { octokit, owner, repo } = await repositoryOf(target);
      try {
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: Number(issue),
          body: `${text}\n\n${commentMarkerLine(marker)}`,
        });
      } catch (error) {
        throw issueCallFailed("a comment on a mirror issue", error);
      }
    },

    async findComment(target, issue, marker, since) {
      const { octokit, owner, repo } = await repositoryOf(target);
      const line = commentMarkerLine(marker);
      try {
        for await (const page of pagesOf(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: Number(issue),
          since: since.toISOString(),
          per_page: 100,
        })) {
          const comments = COMMENTS.safeParse(page);
          if (!comments.success) throw new GitHubUnavailableError("GitHub's answer to the listing of a mirror issue's comments lists no comments.");
          if (comments.data.some(({ body }) => (body ?? "").includes(line))) return true;
        }
      } catch (error) {
        throw issueCallFailed("the listing of a mirror issue's comments", error);
      }
      return false;
    },

    async readIssue(target, issue): Promise<IssueNow | undefined> {
      const { octokit, owner, repo } = await repositoryOf(target);
      let data: unknown;
      try {
        ({ data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: Number(issue) }));
      } catch (error) {
        const status = statusOfCall(error);
        // GitHub answers 404 for an issue it does not have, and 410 for one that was deleted.
        if (status === 404 || status === 410) return undefined;
        throw gitHubUnavailable("the read of a mirror issue", error);
      }
      const read = ISSUE.safeParse(data);
      if (!read.success || read.data.number !== Number(issue)) throw new GitHubUnavailableError("GitHub's answer to the read of a mirror issue names no such issue.");
      const now = read.data;
      return {
        open: now.state === "open",
        closeReason: now.state === "open" ? null : closeReasonOf(now.state_reason),
        assignees: (now.assignees ?? []).map(accountOf),
        closedBy: now.state === "closed" && now.closed_by !== null && now.closed_by !== undefined ? accountOf(now.closed_by) : null,
      };
    },
  };
}
