import { standingList } from "@tiehall/catalog";
import { formatRequestKey, mayGiveSecondConfirmation, type SecondConfirmer } from "@tiehall/core";
import { members, proposalConfirmations, proposalNotices, proposals, requests, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { commitmentPhrase, installLink, PROPOSAL_NOTICE, requestKey, serverTime } from "./email.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import { proposalView } from "./proposals.ts";
import { receiptViews } from "./receipts.ts";
import { actingUserOf } from "./request-changes.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// Where a proposal waits (requests: Where a proposal waits; requester-loop:
// The web inbox; design.md, Decisions this change rests on: D30 (4); design.md,
// Self-hosting decisions: S7 and S10). Who a pending proposal waits for is
// decided at each moment, from the install as it is then: first its
// accountable human, while they are a member; once that human has confirmed a
// commitment that needs the other side, each member who may give the other
// side's confirmation now, as the pure rules decide from the request's current
// parties and each member's current teams. So it follows claims, releases,
// removals and team changes at once, and an expired or ended proposal waits
// for nobody.
// - inbox.standing_list, which only the web UI reads, lists the proposals
//   that wait for the signed-in user, oldest first, and their receipts.
// - A worker job, each minute, emails each person a proposal has started to
//   wait for, once, when email is set up: the email says which request, what
//   the proposal proposes and when it expires, and links its confirm page; it
//   goes to the address sign-in read from their GitHub account. Without SMTP
//   settings, or without an address, nothing is sent, and the standing list is
//   where they find it.

/** Who each pending proposal waits for now, by proposal, in the order the proposals were created. */
export async function waitingByProposal(context: OrgContext, now: Date): Promise<Map<string, string[]>> {
  const { tx, orgId } = context;
  const pending = await tx
    .select({ proposal: proposals, request: requests })
    .from(proposals)
    .innerJoin(requests, and(eq(requests.orgId, proposals.orgId), eq(requests.id, proposals.requestId)))
    .where(and(eq(proposals.orgId, orgId), eq(proposals.state, "pending"), gt(proposals.expiresAt, now)))
    .orderBy(asc(proposals.createdAt), asc(proposals.id));
  const waiting = new Map<string, string[]>();
  if (pending.length === 0) return waiting;
  const confirmed = await tx
    .select({ proposalId: proposalConfirmations.proposalId })
    .from(proposalConfirmations)
    .where(
      and(
        eq(proposalConfirmations.orgId, orgId),
        eq(proposalConfirmations.step, "accountable_human"),
        inArray(
          proposalConfirmations.proposalId,
          pending.map(({ proposal }) => proposal.id),
        ),
      ),
    );
  const accountableConfirmed = new Set(confirmed.map(({ proposalId }) => proposalId));
  // Every member of the install, with the teams they belong to now.
  const memberRows = await tx
    .select({ userId: members.userId, teamId: teamMembers.teamId })
    .from(members)
    .leftJoin(teamMembers, and(eq(teamMembers.orgId, members.orgId), eq(teamMembers.userId, members.userId)))
    .where(eq(members.orgId, orgId))
    .orderBy(asc(members.userId));
  const teamsOf = new Map<string, string[]>();
  for (const { userId, teamId } of memberRows) {
    const teamIds = teamsOf.get(userId) ?? [];
    if (teamId !== null) teamIds.push(teamId);
    teamsOf.set(userId, teamIds);
  }
  for (const { proposal, request } of pending) {
    if (!accountableConfirmed.has(proposal.id)) {
      waiting.set(proposal.id, teamsOf.has(proposal.accountableUserId) ? [proposal.accountableUserId] : []);
      continue;
    }
    const standing = {
      accountableUserId: proposal.accountableUserId,
      second: proposal.secondConfirmation as SecondConfirmer[],
      accountableConfirmed: true,
    };
    const parties = {
      targetTeamId: request.targetTeamId,
      requestingTeamId: request.requestingTeamId,
      requestingUserId: request.requestingUserId,
      claimantId: request.claimantUserId,
      claimantIsMember: request.claimantUserId !== null && teamsOf.has(request.claimantUserId),
    };
    const who = [...teamsOf].filter(([userId, teamIds]) => mayGiveSecondConfirmation(standing, { userId, teamIds }, parties));
    waiting.set(
      proposal.id,
      who.map(([userId]) => userId),
    );
  }
  return waiting;
}

export const PROPOSAL_WAITING_HANDLERS: Handlers = {
  [standingList.id]: defineHandler(standingList, async (_input, context) => {
    const userId = actingUserOf(context);
    const waiting = await waitingByProposal(context, context.now());
    const mine = [...waiting].filter(([, userIds]) => userIds.includes(userId)).map(([proposalId]) => proposalId);
    const views = [];
    for (const proposalId of mine) views.push(await proposalView(context, proposalId));
    return { waiting: views, receipts: await receiptViews(context, userId) };
  }),
};

/** An email about a proposal to send: to whom, and what it says. */
interface Notice {
  proposalId: string;
  userId: string;
  email: string;
  key: string;
  kind: string;
  expiresAt: Date;
}

/**
 * Each minute, emails every person a pending proposal waits for and who has
 * not had its email yet, once email is set up, and records that they have.
 */
export const notifyWaitingProposals: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("proposals.notify", 1, {
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 300,
  }),
  schedule: "* * * * *",
  async handle(_job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    let notices: Notice[];
    try {
      notices = await withOrg(database, (context) => noticesToSend(context, now()), { readOnly: true });
    } catch (error) {
      // Before setup there is no org, and so no proposal.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const notice of notices) {
      await mailer.send(notice.email, PROPOSAL_NOTICE, {
        key: requestKey(notice.key),
        what: commitmentPhrase(notice.kind),
        expiresAt: serverTime(notice.expiresAt),
        page: installLink(installUrl, `/confirm/${notice.proposalId}`),
      });
      await withOrg(database, ({ tx, orgId }) =>
        tx.insert(proposalNotices).values({ orgId, proposalId: notice.proposalId, userId: notice.userId, sentAt: now() }).onConflictDoNothing(),
      );
    }
  },
};

/** The emails to send now: each person a pending proposal waits for, with an address, who has not had its email. */
async function noticesToSend(context: OrgContext, now: Date): Promise<Notice[]> {
  const { tx, orgId } = context;
  const waiting = await waitingByProposal(context, now);
  const notices: Notice[] = [];
  for (const [proposalId, userIds] of waiting) {
    if (userIds.length === 0) continue;
    const sent = await tx
      .select({ userId: proposalNotices.userId })
      .from(proposalNotices)
      .where(and(eq(proposalNotices.orgId, orgId), eq(proposalNotices.proposalId, proposalId)));
    const unsent = userIds.filter((userId) => !sent.some((notice) => notice.userId === userId));
    if (unsent.length === 0) continue;
    const [about] = await tx
      .select({ kind: proposals.kind, expiresAt: proposals.expiresAt, number: requests.number, teamKey: teams.key })
      .from(proposals)
      .innerJoin(requests, and(eq(requests.orgId, proposals.orgId), eq(requests.id, proposals.requestId)))
      .innerJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
      .where(and(eq(proposals.orgId, orgId), eq(proposals.id, proposalId)));
    if (about === undefined) continue;
    const addresses = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.orgId, orgId), inArray(users.id, unsent)))
      .orderBy(asc(users.email));
    for (const { id, email } of addresses) {
      if (email === null) continue;
      notices.push({ proposalId, userId: id, email, key: formatRequestKey(about.teamKey, about.number), kind: about.kind, expiresAt: about.expiresAt });
    }
  }
  return notices;
}
