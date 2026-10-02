import { z } from "zod";
import { defineCommand } from "./command.ts";
import { request, requestKey, requestKeyOutput } from "./requests.ts";
import { GITHUB_REPOSITORY, PULL_REQUEST_URL, user } from "./schemas.ts";

// Linking a pull request to a request (requests: Linked PRs and done on
// merge; agent-surfaces: Tools that change a request directly; agent-surfaces:
// Commitment tools return proposals; design.md, Decisions this change rests
// on: D23, D37). An agent acting for its own signed-in user, or a person in
// the web UI, links a pull request on GitHub.com to a request by the pull
// request's URL, with no proposal; the link is what close on merge later
// looks for. The operation is flagged as a commitment, because linking a pull
// request that had already merged, as a member of the request's target team
// while its state allows done, creates a done proposal too, which the call
// then answers with instead; Tiehall reads the pull request from GitHub to
// know, and answers 502 when GitHub fails that read.
//
// A repository and a pull request's URL are identifiers of GitHub's own form,
// which holds no space, so an output names them outside an untrusted object
// (agent-safety: User text in JSON sits under untrusted objects); an output
// writes them in lower case, as GitHub names repositories without regard to
// case.

export { GITHUB_REPOSITORY, PULL_REQUEST_URL } from "./schemas.ts";

/** A pull request linked to a request, as the operations return it. */
export const pullRequestLink = z.object({
  id: z.uuid(),
  /** The repository, as owner/name, in lower case. */
  repository: z.string().regex(GITHUB_REPOSITORY),
  number: z.number().int().min(1),
  /** The pull request's URL on GitHub.com, with the repository in lower case. */
  url: z.string().regex(PULL_REQUEST_URL),
  linkedAt: z.iso.datetime(),
  /** Who linked it; null for a link no user made. */
  linkedBy: user.nullable(),
});

export const linkPullRequest = defineCommand({
  id: "requests.link_pr",
  summary:
    "Link a pull request on GitHub.com to a request, by the pull request's URL; it needs no confirmation. A pull request is linked to a request once: linking it again answers with the same link. Linking one that has already merged, as a member of the request's target team while the request is claimed, in_progress or needs_info, also creates a done proposal, answered with 202, which people confirm in the web UI.",
  input: z.object({
    key: requestKey,
    url: z
      .string()
      .regex(PULL_REQUEST_URL, "A pull request's URL on GitHub.com, such as https://github.com/acme/web/pull/88.")
      .meta({ description: "The pull request's URL on GitHub.com, such as https://github.com/acme/web/pull/88." }),
  }),
  output: z.object({ request, pullRequest: pullRequestLink }),
  method: "POST",
  path: "/api/v1/requests/{key}/pull-requests",
  scopes: ["requests:write"],
  commitment: true,
  confirm: false,
  surfaces: ["rest", "mcp", "cli"],
  tool: "link_pr",
  cli: [{ command: "link-pr", arguments: ["key", "url"] }],
  stability: "alpha",
});

// Close on merge (requests: Linked PRs and done on merge; requests: System
// actions need no proposal or confirmation; contract-changes: Consumers close
// requests with their own PR; design.md, Decisions this change rests on: D23;
// design.md, Design rules: Requests and events). An internal system command,
// which only the worker runs, as the integration event from GitHub, once a
// delivery of the install's GitHub App or the poll of polling mode has shown a
// merged pull request of a covered repository, read from GitHub as it is now:
// it moves to done each request the pull request was linked to, or whose key
// it mentions, before it merged, that was claimed before it merged and is
// claimed, in_progress or needs_info, and that is not a request of the pull
// request's own contract change sets. It runs once per merge: a later
// processing of the same merge closes nothing. No person and no agent runs it.

/** The most request keys one merged pull request's title, body and branch name are read for. */
export const MENTIONS_MAX = 50;

export const closeOnMerge = defineCommand({
  id: "requests.close_on_merge",
  summary:
    "Move to done the requests a merged pull request closes: those it was linked to, or whose key it mentions in its title, body or branch name, that were claimed before it merged and are claimed, in_progress or needs_info.",
  input: z.object({
    repositoryId: z.int().min(1).meta({ description: "The pull request's repository, by GitHub's id." }),
    repository: z.string().regex(GITHUB_REPOSITORY).meta({ description: "The pull request's repository, as owner/name." }),
    number: z.int().min(1).max(2_147_483_647).meta({ description: "The pull request's number." }),
    mergedAt: z.iso.datetime().meta({ description: "When the pull request merged, as GitHub gives it." }),
    mentions: z.array(requestKey).max(MENTIONS_MAX).meta({ description: "The request keys its title, body and branch name mention, in upper case." }),
  }),
  output: z.object({ done: z.array(requestKeyOutput).meta({ description: "The keys of the requests the merge moved to done." }) }),
  scopes: [],
  commitment: false,
  confirm: false,
  system: true,
  surfaces: [],
  stability: "alpha",
});

export const PULL_REQUEST_COMMANDS = [linkPullRequest, closeOnMerge];
