import { linkPullRequest, type pullRequestLink } from "@tiehall/catalog";
import { changeRequest, Refusal, requestPullRequestLinked } from "@tiehall/core";
import { pullRequestLinks, users } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { definePreparedHandler, type Handlers, type PrepareContext } from "./execute.ts";
import { GitHubUnavailableError } from "./github-client.ts";
import { installationCoveringNamed, readPullRequest } from "./github-pull-requests.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf, lifecycleOf, lockRequest, stampOf, teamActedFor } from "./request-changes.ts";
import { resolveRequestKey } from "./request-keys.ts";
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
// Close on merge reads the links (close-on-merge.ts), each with the time it
// was made by the database's clock, which it compares with GitHub's merge
// time.
//
// A pull request that had already merged (requests: Linked PRs and done on
// merge; agent-surfaces: Commitment tools return proposals). Before the
// call's transaction, Tiehall reads a pull request it has not linked to the
// request yet from GitHub, through the connected installation that covers its
// repository, with that installation's token, which tells whether it has
// merged; GitHub failing the read is refused with 502, as the error model
// gives an integration that fails, and links nothing. A merged pull request is
// linked like any other, and, when the user who links it is a member of the
// request's target team and the request's state allows a move to done
// (claimed, in_progress or needs_info), the call also creates a done
// proposal, with that user as its accountable human, and answers with it,
// 202 on REST: a person confirms it in the web UI. Linked by anyone else, or
// to a request whose state does not allow done, it is only linked. A pull
// request of a repository no connected installation covers cannot be read, so
// it is only linked: it could not close the request on merge either.

/**
 * When the pull request merged, as GitHub gives it now, read before the
 * call's transaction through the connected installation that covers its
 * repository: null when it has not merged, or when Tiehall cannot read it,
 * because no connected installation covers the repository, the install has no
 * App, or GitHub knows no such pull request; undefined when the request has
 * the link already, whose call reads nothing. GitHub failing the read is
 * refused with 502, and nothing is linked.
 */
async function mergedAtOf(input: { key: string; url: string }, context: PrepareContext): Promise<{ mergedAt: string | null } | undefined> {
  const pullRequest = pullRequestOf(input.url);
  const known = await context.read(async (orgContext) => {
    try {
      const { requestId } = await resolveRequestKey(orgContext, input.key);
      return (await linkOf(orgContext, requestId, pullRequest)) !== undefined;
    } catch (error) {
      // A key that names no request: the handler refuses it.
      if (error instanceof Refusal) return true;
      throw error;
    }
  });
  if (known) return undefined;
  const app = await context.github?.app();
  if (app === undefined) return { mergedAt: null };
  const covering = await context.read((orgContext) => installationCoveringNamed(orgContext, app.appId, `${pullRequest.owner}/${pullRequest.name}`));
  if (covering === undefined) return { mergedAt: null };
  try {
    const read = await readPullRequest(app.client, covering.installationId, covering.fullName, pullRequest.number);
    return { mergedAt: read?.mergedAt?.toISOString() ?? null };
  } catch (error) {
    if (error instanceof GitHubUnavailableError) {
      throw new Refusal("integration-unavailable", `${error.message} Tiehall reads a pull request before it links it, to know whether it has merged; nothing was linked, so link it again.`);
    }
    throw error;
  }
}

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
  [linkPullRequest.id]: definePreparedHandler(linkPullRequest, mergedAtOf, async ({ key, url }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    const pullRequest = pullRequestOf(url);
    const linked = await linkOf(context, row.id, pullRequest);
    if (linked !== undefined) return { request: await requestView(context, row.id), pullRequest: linked };
    const teamId = await teamActedFor(context, userId, row);
    const answer = await context.write(async (writer) => {
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
          // By the database's clock, which close on merge compares GitHub's merge times with (close-on-merge.ts).
          linkedAt: sql`now()`,
        })
        .returning({ id: pullRequestLinks.id });
      if (created === undefined) throw new Error("The new pull request link was not returned.");
      await writer.record(requestPullRequestLinked, { requestId: row.id, pullRequestLinkId: created.id });
      const link = await linkOf(writer, row.id, pullRequest);
      if (link === undefined) throw new Error("The new pull request link was not found.");
      return { request: await requestView(writer, row.id), pullRequest: link };
    }, { teamId });
    // A pull request that had already merged, linked by a member of the target team while the state allows done: a done proposal too.
    if (context.prepared?.mergedAt === undefined || context.prepared.mergedAt === null) return answer;
    const ofTargetTeam = (await teamsOfMember(context, userId)).some(({ id }) => id === row.targetTeamId);
    if (!ofTargetTeam || !changeRequest(await lifecycleOf(context, row), { kind: "done" }).ok) return answer;
    return context.propose(row, { kind: "done", change: {} });
  }),
};
