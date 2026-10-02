import { formatRequestKey } from "@tiehall/core";
import { members, messages, questionNotices, requests, teams, users } from "@tiehall/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { installLink, QUESTION_NOTICE, requestKey, teamKey, updateSubject } from "./email.ts";
import { optedInMembersOf } from "./email-settings.ts";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// A question is emailed at once to the person it is asked of (requester-loop:
// Email for people, only when SMTP is set; agent-safety: Notices that can
// reach a model carry only server text; design.md, Decisions this change
// rests on: D28 #61; design.md, Self-hosting decisions: S10; design.md,
// Readings to confirm with the founder: R16). Posting a question starts this
// job in the posting transaction. The question is asked of one person, decided
// when the job runs, from the side that asked it, which its provenance names:
// a question the target team asks is asked of the request's requester, and
// one the requester side asks of the claimant; while nobody holds the claim,
// the requester side's question is asked of no one person, and is emailed to
// nobody right away. With SMTP set, that person gets the email, whatever their
// digest setting, since it is transactional, at the primary verified address
// of their GitHub account, once: the job records whom it emailed in the
// transaction that sends the email, so a send that fails leaves no record and
// is tried again, and a job that cannot reach the database once the email went
// out has recorded it already; the daily digest reads the record to leave the
// question out. The subject carries only the
// request's key, the event's type and the request's target team, and the text
// only Tiehall's words and the request's URL. Without SMTP, or without an
// address, nothing is sent, and the question waits in the web inbox. A request
// whose requester is a team alone, which only a contract report opens, asks
// that team: its question goes by email to each member of the team who opted
// in to the team's emails as a requester, and to no one else, while every
// member finds it in their web inbox (requester-loop: When the requester is a
// team).

export interface QuestionEmailData extends Record<string, unknown> {
  messageId: string;
}

/** The emails about a question to send now: to whom, and what they name. */
interface QuestionNotice {
  recipients: { userId: string; email: string }[];
  key: string;
  targetTeam: string;
  asker: string;
}

/** Whom a question is asked of, and what the email about it names; undefined when it goes to nobody, or went already to each. */
async function noticeOf(context: OrgContext, messageId: string): Promise<QuestionNotice | undefined> {
  const { tx, orgId } = context;
  const [question] = await tx
    .select({
      kind: messages.kind,
      poster: messages.actorUserId,
      teamId: messages.teamId,
      targetTeamId: requests.targetTeamId,
      requestingTeamId: requests.requestingTeamId,
      requestingUserId: requests.requestingUserId,
      claimantUserId: requests.claimantUserId,
      number: requests.number,
    })
    .from(messages)
    .innerJoin(requests, and(eq(requests.orgId, messages.orgId), eq(requests.id, messages.requestId)))
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  if (question === undefined || question.kind !== "question" || question.teamId === null) return undefined;
  // The target team asks the requester: its requesting user, or, for a team alone, the members who opted in to its emails.
  // The requester side asks the claimant, or no one while nobody holds the claim.
  let askedOf: string[] = [];
  if (question.teamId === question.targetTeamId) {
    askedOf = question.requestingUserId !== null ? [question.requestingUserId] : await optedInMembersOf(context, question.requestingTeamId);
  } else if (question.teamId === question.requestingTeamId && question.claimantUserId !== null) {
    askedOf = [question.claimantUserId];
  }
  askedOf = askedOf.filter((userId) => userId !== question.poster);
  if (askedOf.length === 0) return undefined;
  const sent = await tx
    .select({ userId: questionNotices.userId })
    .from(questionNotices)
    .where(and(eq(questionNotices.orgId, orgId), eq(questionNotices.messageId, messageId), inArray(questionNotices.userId, askedOf)));
  const unsent = askedOf.filter((userId) => !sent.some((notice) => notice.userId === userId));
  if (unsent.length === 0) return undefined;
  const addressed = await tx
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(members, and(eq(members.orgId, users.orgId), eq(members.userId, users.id)))
    .where(and(eq(users.orgId, orgId), inArray(users.id, unsent)))
    .orderBy(asc(users.email));
  const recipients = addressed.flatMap(({ userId, email }) => (email === null ? [] : [{ userId, email }]));
  if (recipients.length === 0) return undefined;
  const keyOf = async (teamId: string) => (await tx.select({ key: teams.key }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.id, teamId))))[0]?.key ?? "";
  const targetTeam = await keyOf(question.targetTeamId);
  return { recipients, key: formatRequestKey(targetTeam, question.number), targetTeam, asker: await keyOf(question.teamId) };
}

export const emailQuestion: WorkerJob<QuestionEmailData> = {
  type: defineJobType<QuestionEmailData>("questions.email", 1, {
    retryLimit: 5,
    retryDelaySeconds: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  }),
  async handle(job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    let notice: QuestionNotice | undefined;
    try {
      notice = await withOrg(database, (context) => noticeOf(context, job.data.messageId), { readOnly: true });
    } catch (error) {
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    if (notice === undefined) return;
    const { recipients, key, targetTeam, asker } = notice;
    for (const { userId, email } of recipients) {
      await withOrg(database, async ({ tx, orgId }) => {
        const recorded = await tx
          .insert(questionNotices)
          .values({ orgId, messageId: job.data.messageId, userId, sentAt: now() })
          .onConflictDoNothing()
          .returning({ userId: questionNotices.userId });
        // Another run recorded it first, and sends it.
        if (recorded.length === 0) return;
        await mailer.send(email, QUESTION_NOTICE, {
          subject: updateSubject({ installUrl, key, eventType: "request.message_posted", team: targetTeam }),
          key: requestKey(key),
          asker: teamKey(asker),
          page: installLink(installUrl, `/${key}`),
        });
      });
    }
  },
};
