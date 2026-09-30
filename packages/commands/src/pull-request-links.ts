import { linkPullRequest, type pullRequestLink } from "@tiehall/catalog";
import { requestPullRequestLinked } from "@tiehall/core";
import { pullRequestLinks, users } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type Handlers } from "./execute.ts";
import { actingUserOf, lockRequest, stampOf, teamActedFor } from "./request-changes.ts";
import { requestView } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// Linking a pull request to a request (requests: Linked PRs and done on
// merge; agent-surfaces: Tools that change a request directly; requests: The
// event log; design.md, Decisions this change rests on: D23; design.md,
// Design rules: Requests and events). An agent acting for its own signed-in
// user, or a person in the web UI, links a pull request on GitHub.com to a
// request by its URL, with no proposal: the request's row is locked, the link
// is stored with the caller's provenance, as the server stamped it, and its
// domain event commits with it. Linking is a write on the request, which the
// loop limit counts for an agent and refuses while the request waits for a
// person (agent-safety: Runaway agent loops flag the request needs_human).
//
// Reading: the spec names no side for linking, as it does for claiming or
// withdrawing, so any member of the install may link, as any member may read
// the request; nor does it limit linking by the request's state.
//
// A pull request is linked to a request once. GitHub names repositories
// without regard to case, so the link keeps the repository in lower case, and
// the same pull request linked again, in any case, answers with the link it
// has, and changes and records nothing.
//
// Not built yet: reading the pull request from GitHub, with an installation
// token of the install's GitHub App, which tells whether it had already
// merged; a target-team member's link of a merged pull request then creates a
// done proposal, which the call answers with instead (tasks 23.15, 23.16).

/** A pull request linked to a request, as the operations return it. */
export type PullRequestLinkView = z.input<typeof pullRequestLink>;

/** The repository and number a pull request's URL names, the repository in lower case. */
export function pullRequestOf(url: string): { owner: string; name: string; number: number } {
  const [, owner = "", name = "", , number = ""] = new URL(url).pathname.split("/");
  return { owner: owner.toLowerCase(), name: name.toLowerCase(), number: Number(number) };
}

/** The link of this pull request to the request, as the operations return it; none when it is not linked. */
async function linkOf(
  { tx, orgId }: OrgContext,
  requestId: string,
  pullRequest: { owner: string; name: string; number: number },
): Promise<PullRequestLinkView | undefined> {
  const [row] = await tx
    .select({ link: pullRequestLinks, login: users.githubLogin, bot: users.bot })
    .from(pullRequestLinks)
    .leftJoin(users, and(eq(users.orgId, pullRequestLinks.orgId), eq(users.id, pullRequestLinks.actorUserId)))
    .where(
      and(
        eq(pullRequestLinks.orgId, orgId),
        eq(pullRequestLinks.requestId, requestId),
        eq(pullRequestLinks.repositoryOwner, pullRequest.owner),
        eq(pullRequestLinks.repositoryName, pullRequest.name),
        eq(pullRequestLinks.number, pullRequest.number),
      ),
    );
  if (row === undefined) return undefined;
  const { link, login, bot } = row;
  const repository = `${link.repositoryOwner}/${link.repositoryName}`;
  return {
    id: link.id,
    repository,
    number: link.number,
    url: `https://github.com/${repository}/pull/${link.number}`,
    linkedAt: link.linkedAt.toISOString(),
    linkedBy: link.actorUserId === null || login === null ? null : { id: link.actorUserId, login, kind: "human", bot: bot ?? false },
  };
}

export const PULL_REQUEST_LINK_HANDLERS: Handlers = {
  [linkPullRequest.id]: defineHandler(linkPullRequest, async ({ key, url }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    const pullRequest = pullRequestOf(url);
    const linked = await linkOf(context, row.id, pullRequest);
    if (linked !== undefined) return { request: await requestView(context, row.id), pullRequest: linked };
    const teamId = await teamActedFor(context, userId, row);
    return context.write(async (writer) => {
      await writer.changesRequest(row.id);
      const [created] = await writer.tx
        .insert(pullRequestLinks)
        .values({
          orgId: writer.orgId,
          requestId: row.id,
          repositoryOwner: pullRequest.owner,
          repositoryName: pullRequest.name,
          number: pullRequest.number,
          ...stampOf(writer.provenance, teamId),
          linkedAt: writer.now(),
        })
        .returning({ id: pullRequestLinks.id });
      if (created === undefined) throw new Error("The new pull request link was not returned.");
      await writer.record(requestPullRequestLinked, { requestId: row.id, pullRequestLinkId: created.id });
      const link = await linkOf(writer, row.id, pullRequest);
      if (link === undefined) throw new Error("The new pull request link was not found.");
      return { request: await requestView(writer, row.id), pullRequest: link };
    }, { teamId });
  }),
};
