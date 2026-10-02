import { z } from "zod";
import { defineCommand } from "./command.ts";
import { request, requestKey } from "./requests.ts";
import { GITHUB_REPOSITORY, PULL_REQUEST_URL, user } from "./schemas.ts";

// Linking a pull request to a request (requests: Linked PRs and done on
// merge; agent-surfaces: Tools that change a request directly; agent-surfaces:
// Commitment tools return proposals; design.md, Decisions this change rests
// on: D23, D37). An agent acting for its own signed-in user, or a person in
// the web UI, links a pull request on GitHub.com to a request by the pull
// request's URL, with no proposal; the link is what close on merge later
// looks for. The operation is flagged as a commitment, because linking a pull
// request that had already merged creates a done proposal, which the call
// then answers with instead (tasks 23.15 and 23.16 build close on merge and
// that proposal).
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
    "Link a pull request on GitHub.com to a request, by the pull request's URL; it needs no confirmation. A pull request is linked to a request once: linking it again answers with the same link.",
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

export const PULL_REQUEST_COMMANDS = [linkPullRequest];
