import { confirmFanOut, type banner } from "@tiehall/catalog";
import { contractFanOutConfirmed, Refusal } from "@tiehall/core";
import { apis, contractChangeRequests, contractChangeSets, contractFanOutApprovals, contractFanOutWaits, teams } from "@tiehall/db";
import { and, asc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { z } from "zod";
import { emailAdminAlerts } from "./admin-alerts.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { applyChangeSets } from "./contract-routing.ts";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// One PR reaches at most 10 consumer teams without an admin (agent-safety: One
// PR reaches at most 10 consumer teams without an admin; agent-safety: Actions
// that need the confirmation step; activity-log: Which actions are security
// events; tracker-mirrors: Broken integrations are surfaced; design.md,
// Decisions this change rests on: D28 #41, #52; design.md, Self-hosting
// decisions: S7, S10; design.md, Readings to confirm with the founder: R15).
//
// A provider pull request reaches the consumer teams its change sets opened
// requests to, one change set per API it changes. A change set's update
// (contract-routing.ts) takes the teams that consume the API and have no
// request for the change set, oldest declaration of the API first, then by
// team key, and lets each in: a team the pull request reached already through
// another change set, which counts once; a team an admin confirmed for the
// change set; or a new team while the pull request has reached fewer than 10.
// The rest wait for an admin. While teams of a change set wait, every admin
// sees a banner, in the web UI's admin page and home page, that leads to the
// review page of the confirmation, and, when SMTP is set, gets one email about
// it (admin-alerts.ts), which the update that made the first team wait starts.
// A team stops waiting once an admin confirms it, or once the change set's
// update no longer lets it in at all, such as when its declaration is removed
// or the breaking changes are gone.
//
// An admin confirms, in the web UI with the confirmation step, that the
// breaking changes reach the waiting teams the review page names: an admin
// action, recorded as a security event, which takes the teams out of the wait
// and starts the change set's update, which opens their requests as the system
// from GitHub, as it opens every request of a contract report. A confirmation
// that names no team that waits gets 409 and changes nothing.
//
// The locks: an update or a confirmation locks every change set of the pull
// request first, in the order of their ids, so the count of the teams the pull
// request reached holds while it decides.

/** The consumer teams one provider pull request reaches without an admin. */
export const FAN_OUT_LIMIT = 10;

/** A change set as the fan-out reads it. */
export interface FanOutChangeSet {
  id: string;
  repositoryId: number;
  pullRequestNumber: number;
  fanOutWaitingSince: Date | null;
}

/** A team that consumes the API: its id and key. */
export interface ConsumingTeam {
  id: string;
  key: string;
}

/** The ids of the teams the pull request reached: those its change sets opened requests to. */
async function teamsReached({ tx, orgId }: OrgContext, changeSet: FanOutChangeSet): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ teamId: contractChangeRequests.teamId })
    .from(contractChangeRequests)
    .innerJoin(contractChangeSets, and(eq(contractChangeSets.orgId, contractChangeRequests.orgId), eq(contractChangeSets.id, contractChangeRequests.changeSetId)))
    .where(
      and(
        eq(contractChangeRequests.orgId, orgId),
        eq(contractChangeSets.repositoryId, changeSet.repositoryId),
        eq(contractChangeSets.pullRequestNumber, changeSet.pullRequestNumber),
      ),
    );
  return new Set(rows.map(({ teamId }) => teamId));
}

/** The ids of the teams an admin confirmed for the change set. */
async function teamsConfirmed({ tx, orgId }: OrgContext, changeSetId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ teamId: contractFanOutApprovals.teamId })
    .from(contractFanOutApprovals)
    .where(and(eq(contractFanOutApprovals.orgId, orgId), eq(contractFanOutApprovals.changeSetId, changeSetId)));
  return new Set(rows.map(({ teamId }) => teamId));
}

/**
 * Which of the candidates, consuming teams without a request for the change
 * set in their order, the update lets in, and which wait for an admin.
 */
export async function fanOut<T extends ConsumingTeam>(context: OrgContext, changeSet: FanOutChangeSet, candidates: readonly T[]): Promise<{ letIn: T[]; waiting: T[] }> {
  const reached = await teamsReached(context, changeSet);
  const confirmed = await teamsConfirmed(context, changeSet.id);
  const letIn: T[] = [];
  const waiting: T[] = [];
  for (const team of candidates) {
    if (reached.has(team.id) || confirmed.has(team.id) || reached.size < FAN_OUT_LIMIT) {
      letIn.push(team);
      reached.add(team.id);
    } else {
      waiting.push(team);
    }
  }
  return { letIn, waiting };
}

/**
 * Records which teams of the change set wait now, in the update's
 * transaction: a team that waits keeps the time it started to; one that no
 * longer waits leaves the wait. When the first team starts to wait, the change
 * set records since when, which raises the admins' banner, and the email to
 * the admins starts; when none waits any more, the banner goes.
 */
export async function recordWaiting(context: HandlerContext, changeSet: FanOutChangeSet, waiting: readonly ConsumingTeam[]): Promise<void> {
  const { tx, orgId } = context;
  const ids = waiting.map(({ id }) => id);
  await tx
    .delete(contractFanOutWaits)
    .where(and(eq(contractFanOutWaits.orgId, orgId), eq(contractFanOutWaits.changeSetId, changeSet.id), ...(ids.length === 0 ? [] : [notInArray(contractFanOutWaits.teamId, ids)])));
  const now = context.now();
  if (ids.length > 0) {
    await tx
      .insert(contractFanOutWaits)
      .values(ids.map((teamId) => ({ orgId, changeSetId: changeSet.id, teamId, waitingSince: now })))
      .onConflictDoNothing();
  }
  const since = ids.length === 0 ? null : (changeSet.fanOutWaitingSince ?? now);
  if (since?.getTime() === changeSet.fanOutWaitingSince?.getTime()) return;
  await tx
    .update(contractChangeSets)
    .set({ fanOutWaitingSince: since })
    .where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.id, changeSet.id)));
  if (since !== null) await context.enqueue(emailAdminAlerts.type, { alert: "contract_fan_out", raisedAt: since.toISOString(), changeSetId: changeSet.id });
}

/** A fan-out that waits for an admin: its change set, the pull request and the API, since when, and the teams that wait, by key. */
export interface WaitingFanOut {
  changeSetId: string;
  api: string;
  repository: string;
  pullRequestNumber: number;
  since: Date;
  teams: ConsumingTeam[];
}

/** The fan-outs that wait for an admin, oldest first; one change set's alone when it is named. */
export async function waitingFanOuts({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, changeSetId?: string): Promise<WaitingFanOut[]> {
  const rows = await tx
    .select({
      changeSetId: contractChangeSets.id,
      api: apis.name,
      repository: apis.repositoryFullName,
      pullRequestNumber: contractChangeSets.pullRequestNumber,
      since: contractChangeSets.fanOutWaitingSince,
      teamId: teams.id,
      teamKey: teams.key,
    })
    .from(contractChangeSets)
    .innerJoin(apis, and(eq(apis.orgId, contractChangeSets.orgId), eq(apis.id, contractChangeSets.apiId)))
    .innerJoin(contractFanOutWaits, and(eq(contractFanOutWaits.orgId, contractChangeSets.orgId), eq(contractFanOutWaits.changeSetId, contractChangeSets.id)))
    .innerJoin(teams, and(eq(teams.orgId, contractFanOutWaits.orgId), eq(teams.id, contractFanOutWaits.teamId)))
    .where(and(eq(contractChangeSets.orgId, orgId), isNotNull(contractChangeSets.fanOutWaitingSince), ...(changeSetId === undefined ? [] : [eq(contractChangeSets.id, changeSetId)])))
    .orderBy(asc(contractChangeSets.fanOutWaitingSince), asc(contractChangeSets.id), asc(teams.key));
  const byChangeSet = new Map<string, WaitingFanOut>();
  for (const row of rows) {
    const fanOut = byChangeSet.get(row.changeSetId) ?? {
      changeSetId: row.changeSetId,
      api: row.api,
      repository: row.repository,
      pullRequestNumber: row.pullRequestNumber,
      since: row.since ?? new Date(0),
      teams: [],
    };
    fanOut.teams.push({ id: row.teamId, key: row.teamKey });
    byChangeSet.set(row.changeSetId, fanOut);
  }
  return [...byChangeSet.values()];
}

/** "MOB", "MOB and WEB", or "APP, MOB and WEB". */
function listed(keys: readonly string[]): string {
  return keys.length <= 2 ? keys.join(" and ") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

/** The review page of the confirmation of a waiting fan-out, as a path on the install. */
export function fanOutReviewPath(fanOut: WaitingFanOut): string {
  const input = { changeSet: fanOut.changeSetId, teams: fanOut.teams.map(({ id }) => id) };
  return `/confirm/${confirmFanOut.id}?input=${encodeURIComponent(JSON.stringify(input))}`;
}

/** The admins' banner about a waiting fan-out, in Tiehall's words, with the review page of its confirmation. */
export function fanOutBanner(fanOut: WaitingFanOut): z.output<typeof banner> {
  const count = fanOut.teams.length;
  return {
    id: "contract_fan_out",
    text:
      `${count} consumer team${count === 1 ? "" : "s"} wait${count === 1 ? "s" : ""} for an admin to confirm that the breaking changes of ${fanOut.repository}#${fanOut.pullRequestNumber} to ${fanOut.api} reach them: ${listed(fanOut.teams.map(({ key }) => key))}. ` +
      `One pull request reaches at most ${FAN_OUT_LIMIT} consumer teams without an admin's confirmation.`,
    link: { href: fanOutReviewPath(fanOut), text: "Review and confirm the fan-out" },
  };
}

/** Locks every change set of the change set's pull request, in the order of their ids; returns the named one's row; 404 when there is none. */
export async function lockPullRequestChangeSets(context: OrgContext, changeSetId: string) {
  const { tx, orgId } = context;
  const [named] = await tx
    .select({ repositoryId: contractChangeSets.repositoryId, pullRequestNumber: contractChangeSets.pullRequestNumber })
    .from(contractChangeSets)
    .where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.id, changeSetId)));
  if (named === undefined) throw new Refusal("record-not-found", "There is no such change set.");
  const rows = await lockChangeSetsOfPullRequest(context, named.repositoryId, named.pullRequestNumber);
  const row = rows.find(({ id }) => id === changeSetId);
  if (row === undefined) throw new Refusal("record-not-found", "There is no such change set.");
  return row;
}

/** Locks every change set of a repository's pull request, one per API it changes, in the order of their ids, and returns them; none when no report named it. */
export async function lockChangeSetsOfPullRequest({ tx, orgId }: OrgContext, repositoryId: number, pullRequestNumber: number) {
  return tx
    .select({
      id: contractChangeSets.id,
      apiId: contractChangeSets.apiId,
      repositoryId: contractChangeSets.repositoryId,
      pullRequestNumber: contractChangeSets.pullRequestNumber,
      appliedReportId: contractChangeSets.appliedReportId,
      burstStartedAt: contractChangeSets.burstStartedAt,
      fanOutWaitingSince: contractChangeSets.fanOutWaitingSince,
      providerClosedAt: contractChangeSets.providerClosedAt,
    })
    .from(contractChangeSets)
    .where(and(eq(contractChangeSets.orgId, orgId), eq(contractChangeSets.repositoryId, repositoryId), eq(contractChangeSets.pullRequestNumber, pullRequestNumber)))
    .orderBy(asc(contractChangeSets.id))
    .for("update");
}

export const CONTRACT_FAN_OUT_HANDLERS: Handlers = {
  [confirmFanOut.id]: defineHandler(confirmFanOut, async ({ changeSet: changeSetId, teams: named }, context) => {
    const userId = actingUserOf(context);
    return context.write(async (writer) => {
      const changeSet = await lockPullRequestChangeSets(writer, changeSetId);
      const [fanOut] = await waitingFanOuts(writer, changeSetId);
      const confirmed = (fanOut?.teams ?? []).filter(({ id }) => named.includes(id));
      if (fanOut === undefined || confirmed.length === 0) {
        throw new Refusal("conflict", "None of these teams waits for an admin to confirm this fan-out any more, so nothing was confirmed.");
      }
      const now = writer.now();
      await writer.tx
        .insert(contractFanOutApprovals)
        .values(confirmed.map(({ id }) => ({ orgId: writer.orgId, changeSetId, teamId: id, approvedByUserId: userId, approvedAt: now })))
        .onConflictDoNothing();
      await writer.tx.delete(contractFanOutWaits).where(
        and(
          eq(contractFanOutWaits.orgId, writer.orgId),
          eq(contractFanOutWaits.changeSetId, changeSetId),
          inArray(
            contractFanOutWaits.teamId,
            confirmed.map(({ id }) => id),
          ),
        ),
      );
      if (confirmed.length === fanOut.teams.length) {
        await writer.tx
          .update(contractChangeSets)
          .set({ fanOutWaitingSince: null })
          .where(and(eq(contractChangeSets.orgId, writer.orgId), eq(contractChangeSets.id, changeSet.id)));
      }
      await writer.record(contractFanOutConfirmed, { changeSetId, teams: confirmed.length });
      // The change set's update opens the confirmed teams' requests, as the system from GitHub.
      await writer.enqueue(applyChangeSets.type, { changeSetId });
      return { confirmed: confirmed.map(({ key }) => key) };
    });
  }),
};

export const CONTRACT_FAN_OUT_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [confirmFanOut.id]: async (input, context) => {
    const { changeSet, teams: named } = input as z.output<typeof confirmFanOut.input>;
    const title = "Confirm a contract-change fan-out";
    const [fanOut] = await waitingFanOuts(context, changeSet);
    const confirming = (fanOut?.teams ?? []).filter(({ id }) => named.includes(id));
    if (fanOut === undefined || confirming.length === 0) {
      return { title, lines: [{ text: "None of these teams waits for an admin to confirm a fan-out any more, so confirming lets no team in." }] };
    }
    const keys = listed(confirming.map(({ key }) => key));
    return {
      title,
      lines: [
        {
          text: `Let the breaking changes of the provider pull request ${fanOut.repository}#${fanOut.pullRequestNumber} to ${fanOut.api} reach ${keys}, beyond the ${FAN_OUT_LIMIT} consumer teams the pull request reaches without an admin.`,
        },
        { text: `Each of them then gets a request about the changes, opened by Tiehall, as every consuming team does.` },
        ...(confirming.length < fanOut.teams.length
          ? [{ text: `${listed(fanOut.teams.filter(({ id }) => !named.includes(id)).map(({ key }) => key))} keep waiting.` }]
          : []),
      ],
    };
  },
};
