import { retryMirrorJob } from "@tiehall/catalog";
import { formatRequestKey, Refusal } from "@tiehall/core";
import { mirrorFailures, requests, teamMembers, teams, type Database } from "@tiehall/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Banner } from "./admin-alerts.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { LOGGABLE } from "./log.ts";
import type { Member } from "./members.ts";
import { mirrorRequest } from "./mirror-jobs.ts";
import { withOrg, type OrgContext } from "./with-org.ts";
import { createPageRoute, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// Failed mirror jobs (tracker-mirrors: Failed mirror jobs are shown with a
// Retry button; design.md, Decisions this change rests on: D28 #41, #83;
// design.md, Technical decisions: T6). A request's mirror job is tried 5
// times, a fixed 14 minutes apart (mirror-jobs.ts), and when its fifth attempt
// fails it moves to the job type's dead-letter queue. The worker works that
// queue (mirrors.ts): it records the request here, once however often its job
// gets there, with the time of the latest failure.
//
// A recorded job is a banner in the web UI (admin-alerts.ts), with a Retry
// button and a link to the request, for the install's admins and the members
// of the request's target team as it is now, and for no one else. Its jobs
// run one key at a time, but the failed job does not hold back the request's
// later mirror jobs (decisions-from-groups-15-28: design.md, Decisions this
// change rests on: D55 (76); Technical decisions: T10): the next change of
// the request sends a newer job, which takes the failed one out of the queue
// and records it here when the worker has not yet (mirror-jobs.ts), and does
// everything it would have done, since mirror jobs are level-triggered; the
// banner says so. A failed job that a newer one took out of the queue before
// the worker reached its dead letter is not recorded again by it, so a
// banner the newer job cleared does not come back. Who sees the banner may
// press Retry, in the web UI only: it runs the failed job again, at once, with
// one more attempt; with no failed job left in the queue, as when a newer job
// or pg-boss took it out, Retry sends a new one. Anyone else gets 403, and a
// request whose mirror job has not failed gets 409. Retry records when it was
// pressed, which the banner then says; the banner goes once a mirror job of
// the request succeeds, and shows again, with the new time, when the retried
// job fails.
//
// A mirror issue the tracker no longer has, which GitHub answers a write to
// with 404 or 410, as when someone deleted the issue or moved it out of
// Tiehall's reach, is no failure: the adapter throws MirrorIssueGoneError,
// and the job marks the mirror gone, writes to it no more, adds one notice to
// the request, and succeeds, so the banner goes (mirrors.ts; D55 (79)).

/**
 * A write to a mirror issue that the tracker answered as gone: it no longer
 * has the issue, or no longer lets Tiehall reach it (GitHub's 404 or 410).
 * The mirror job marks the mirror gone and writes to it no more (mirrors.ts).
 */
export class MirrorIssueGoneError extends Error {
  override name = "MirrorIssueGoneError";
  readonly [LOGGABLE] = true;
  constructor(tracker: string) {
    super(`The ${tracker} mirror issue is gone: the tracker no longer has it, or no longer lets Tiehall reach it.`);
  }
}

/** Where the Retry button of a failed mirror job's banner posts. */
export const MIRROR_RETRY_PATH = "/mirrors/retry";

/** The pages a Retry leads back to: the two that show the banners, the home page and the admin page. */
const BACK_TO: ReadonlySet<string> = new Set(["/", "/admin"]);

/** A time as a banner shows it: the date, and the hour and minute, in UTC. */
function utcTime(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Records that the request's mirror job reached the dead-letter queue at this time; a later failure replaces an earlier one. */
export async function recordMirrorFailure(database: Database, requestId: string, failedAt: Date): Promise<void> {
  await withOrg(database, async ({ tx, orgId }) => {
    await tx
      .insert(mirrorFailures)
      .values({ orgId, requestId, failedAt })
      .onConflictDoUpdate({ target: [mirrorFailures.orgId, mirrorFailures.requestId], set: { failedAt, retriedAt: null } });
  });
}

/** Forgets the request's failed mirror job, once a mirror job of the request succeeded. */
export async function clearMirrorFailure(database: Database, requestId: string): Promise<void> {
  await withOrg(database, async ({ tx, orgId }) => {
    await tx.delete(mirrorFailures).where(and(eq(mirrorFailures.orgId, orgId), eq(mirrorFailures.requestId, requestId)));
  });
}

/** The ids of the teams the member belongs to. */
async function teamIdsOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId)));
  return rows.map(({ teamId }) => teamId);
}

/** The banners of the failed mirror jobs this member sees: every one for an admin, and those of their teams' requests for anyone else. */
export async function mirrorFailureBanners(context: Pick<OrgContext, "tx" | "orgId">, member: Pick<Member, "userId" | "role"> | undefined): Promise<Banner[]> {
  if (member === undefined) return [];
  const { tx, orgId } = context;
  const teamIds = member.role === "admin" ? undefined : await teamIdsOf(context, member.userId);
  if (teamIds?.length === 0) return [];
  const rows = await tx
    .select({ requestId: mirrorFailures.requestId, failedAt: mirrorFailures.failedAt, retriedAt: mirrorFailures.retriedAt, number: requests.number, team: teams.key })
    .from(mirrorFailures)
    .innerJoin(requests, and(eq(requests.orgId, mirrorFailures.orgId), eq(requests.id, mirrorFailures.requestId)))
    .innerJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
    .where(and(eq(mirrorFailures.orgId, orgId), ...(teamIds === undefined ? [] : [inArray(requests.targetTeamId, teamIds)])))
    .orderBy(asc(mirrorFailures.failedAt), asc(mirrorFailures.requestId));
  return rows.map(({ requestId, failedAt, retriedAt, number, team }) => {
    const key = formatRequestKey(team, number);
    const retrying = retriedAt === null ? "" : ` Retry was pressed at ${utcTime(retriedAt)}: Tiehall is trying again.`;
    return {
      id: `mirror_failed:${requestId}`,
      text:
        `Tiehall could not update the mirror issue of ${key}: its mirror job failed on every attempt, the last at ${utcTime(failedAt)}, and stopped. ` +
        `The next change of ${key} runs its mirror job again, as Retry does.${retrying}`,
      link: { href: `/${key}`, text: `Open ${key}` },
      button: { label: "Retry", action: MIRROR_RETRY_PATH, fields: { requestId } },
    };
  });
}

/** Whether the call acts for someone who sees the request's failed mirror job: an admin, or a member of its target team. */
async function seesFailure(context: HandlerContext, targetTeamId: string): Promise<boolean> {
  const member = context.member;
  if (context.caller.kind !== "web_session" || member === undefined) return false;
  return member.role === "admin" || (await teamIdsOf(context, member.userId)).includes(targetTeamId);
}

export const MIRROR_FAILURE_HANDLERS: Handlers = {
  [retryMirrorJob.id]: defineHandler(retryMirrorJob, async ({ requestId }, context) => {
    const { tx, orgId } = context;
    const [request] = await tx
      .select({ targetTeamId: requests.targetTeamId })
      .from(requests)
      .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
    if (request === undefined) throw new Refusal("record-not-found", "There is no such request.");
    if (!(await seesFailure(context, request.targetTeamId))) {
      throw new Refusal("forbidden", "Only the install's admins and the members of the request's target team retry its mirror job, in the web UI.");
    }
    const [failure] = await tx
      .update(mirrorFailures)
      .set({ retriedAt: context.now() })
      .where(and(eq(mirrorFailures.orgId, orgId), eq(mirrorFailures.requestId, requestId)))
      .returning({ requestId: mirrorFailures.requestId });
    if (failure === undefined) throw new Refusal("conflict", "The request's mirror job has not failed, so there is nothing to retry.");
    // The failed job runs again; with none left in the queue, a new one does.
    if (!(await context.retryFailed(mirrorRequest, requestId))) await context.enqueue(mirrorRequest, { requestId }, { singletonKey: requestId });
    return { requestId };
  }),
};

/** The target of the Retry button of a failed mirror job's banner, for the signed-in member's web session; it leads back to the page it was pressed on. */
export function createMirrorRetryRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: MIRROR_RETRY_PATH,
    name: "home",
    // The button's target has no page of its own: a browser that opens it goes home.
    get: async () => seeOther("/"),
    async post(form, { write }) {
      await write(retryMirrorJob.id, { requestId: form.get("requestId") ?? "" });
      const back = form.get("back") ?? "/";
      return seeOther(BACK_TO.has(back) ? back : "/");
    },
  });
}
