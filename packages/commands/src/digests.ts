import { emailDigests as digestRecords, members, questionNotices, users } from "@tiehall/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  DIGEST,
  DIGEST_UPDATES,
  digestText,
  eventTypeText,
  installLink,
  requestKey,
  serverDay,
  teamKey,
  updateSaid,
  type DigestRequest,
  type ServerText,
} from "./email.ts";
import { EMAIL_SETTINGS_PATH } from "./email-settings-page.ts";
import { INBOX_PATH } from "./inbox-page.ts";
import { defineJobType } from "./jobs.ts";
import { updatesBetween, updatesPageOf } from "./updates.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The daily digest (requester-loop: Email for people, only when SMTP is set;
// agent-safety: The needs_human flag is visible and reaches the people on the
// request; design.md, Decisions this change rests on: D28 #61; D29 (6);
// design.md, Self-hosting decisions: S10; design.md, Readings to confirm with
// the founder: R16). Every hour, the worker looks at the UTC day that ended
// last. Each member with the digest on and an address, whose digest for that
// day has not gone out yet, gets one email that gathers their updates of that
// day, those whats_new returns, from the needs_human events to how proposals
// ended: every update except a question that was emailed to them at once. The
// email goes to the primary verified address of their GitHub account, and the
// worker records that it went, so each day's digest goes out at most once; a
// day with nothing in it sends nothing. Its subject names the day, and its
// text only Tiehall's words and each request's key, target team and URL,
// nothing anyone wrote. Without SMTP, nothing is sent, and a day whose digest
// could not go out then still goes out within the hour SMTP is set.

/** The day before a time's UTC day, which ended last, from its start to its end. */
function lastEndedDay(now: Date): { day: string; from: Date; until: Date } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(until.getTime() - 24 * 3_600_000);
  return { day: from.toISOString().slice(0, 10), from, until };
}

/** A digest to send: to whom, and what it says. */
interface Digest {
  userId: string;
  email: string;
  /** The day's updates, by request. */
  byRequest: DigestRequest[];
  more: number;
  updates: number;
}

/** The digests of the day to send now: one per member with the digest on and an address, not sent yet, that has updates. */
async function digestsOf(context: OrgContext, { day, from, until, installUrl }: { day: string; from: Date; until: Date; installUrl: string }): Promise<Digest[]> {
  const { tx, orgId } = context;
  const recipients = await tx
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(members, and(eq(members.orgId, users.orgId), eq(members.userId, users.id)))
    .where(and(eq(users.orgId, orgId), eq(users.digestEnabled, true), isNotNull(users.email)))
    .orderBy(asc(users.id));
  const sent = new Set(
    (await tx.select({ userId: digestRecords.userId }).from(digestRecords).where(and(eq(digestRecords.orgId, orgId), eq(digestRecords.day, day)))).map(
      ({ userId }) => userId,
    ),
  );
  const digests: Digest[] = [];
  for (const { userId, email } of recipients) {
    if (email === null || sent.has(userId)) continue;
    const { events, more } = await updatesBetween(context, { userId, scope: "whats_new", from, until, limit: 5_000 });
    // A question emailed to the user as it came is not repeated.
    const messageIds = events.map(({ data }) => data["messageId"]).filter((id): id is string => typeof id === "string");
    const emailed = new Set(
      messageIds.length === 0
        ? []
        : (
            await tx
              .select({ messageId: questionNotices.messageId })
              .from(questionNotices)
              .where(and(eq(questionNotices.orgId, orgId), eq(questionNotices.userId, userId), inArray(questionNotices.messageId, messageIds)))
          ).map(({ messageId }) => messageId),
    );
    const kept = events.filter(({ type, data }) => !(type === "request.message_posted" && emailed.has(String(data["messageId"]))));
    if (kept.length === 0) continue;
    const listed = kept.slice(0, DIGEST_UPDATES);
    const page = await updatesPageOf(context, { events: listed, more: false, cursor: 0, installUrl });
    const byRequest = new Map<string, DigestRequest & { updates: DigestRequest["updates"][number][] }>();
    for (const update of page.events) {
      let request = byRequest.get(update.request.id);
      if (request === undefined) {
        request = {
          key: requestKey(update.request.key),
          team: teamKey(update.request.targetTeam.key),
          url: installLink(installUrl, `/${update.request.key}`),
          updates: [],
        };
        byRequest.set(update.request.id, request);
      }
      request.updates.push({ at: update.occurredAt.slice(11, 16) as ServerText, type: eventTypeText(update.type), said: updateSaid(update) });
    }
    const beyond = kept.length - listed.length + (more ? 1 : 0);
    digests.push({ userId, email, byRequest: [...byRequest.values()], more: beyond, updates: kept.length });
  }
  return digests;
}

export const emailDigests: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("digests.email", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 1_800,
  }),
  // Hourly, so a day's digests go out soon after it ends, and a missed hour is made up at the next.
  schedule: "5 * * * *",
  async handle(_job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    const { day, from, until } = lastEndedDay(now());
    let digests: Digest[];
    try {
      digests = await withOrg(database, (context) => digestsOf(context, { day, from, until, installUrl }), { readOnly: true });
    } catch (error) {
      // Before setup there is no org, and so nobody to email.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const digest of digests) {
      const dayText = serverDay(from);
      await mailer.send(digest.email, DIGEST, {
        day: dayText,
        text: digestText({
          day: dayText,
          byRequest: digest.byRequest,
          more: digest.more,
          inbox: installLink(installUrl, INBOX_PATH),
          settings: installLink(installUrl, EMAIL_SETTINGS_PATH),
        }),
      });
      const { userId, updates } = digest;
      await withOrg(database, ({ tx, orgId }) => tx.insert(digestRecords).values({ orgId, userId, day, sentAt: now(), updates }).onConflictDoNothing());
    }
  },
};
