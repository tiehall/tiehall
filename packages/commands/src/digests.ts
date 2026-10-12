import { emailDigests as digestRecords, members, questionNotices, users } from "@tiehall/db";
import { and, asc, eq, inArray, isNotNull, max } from "drizzle-orm";
import {
  DIGEST,
  DIGEST_UPDATES,
  digestText,
  eventTypeText,
  installLink,
  requestKey,
  serverDay,
  serverDays,
  teamKey,
  updateSaid,
  updateTime,
  type DigestRequest,
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
// the founder: R16). Every hour, the worker looks at the UTC days that ended
// since each member's last digest, at most the 7 latest, so a worker that was
// stopped catches up with one email (decisions-from-groups-15-28: design.md,
// Decisions this change rests on: D55 (48); design.md, Technical decisions:
// T7). Each member with the digest on and an address, whose days since their
// last digest include the one that ended last, gets one email that gathers
// their updates of those days, those whats_new returns, from the needs_human
// events to how proposals ended: every update except a question that was
// emailed to them at once, and except every event of their own, what they did
// in the web UI included (decisions-from-groups-15-28: design.md, Decisions
// this change rests on: D55 (43); findings-from-claude-code-run: design.md,
// Findings: F2 (4)). The email goes to the primary verified address of their
// GitHub account, and the worker records that it went, with the first and the
// last day it covers, in the transaction that sends it, so a user gets at most
// one digest a UTC day: a record already there for the day that ended last
// sends nothing, a send that fails leaves no record, so the job sends it when
// it runs again, and a run that cannot reach the database once the email went
// out has recorded it already; days with nothing in them send nothing, and
// stay for the next digest to cover. Its subject names the days it covers,
// the first and the last, whichever of them its updates fall on, and its text
// only Tiehall's words and each request's key, target team and URL, nothing
// anyone wrote. Without SMTP, nothing is sent, and the days whose digest could
// not go out then still go out within the hour SMTP is set.

/** How many of the latest ended UTC days a digest covers at most. */
export const DIGEST_DAYS = 7;

const DAY_MS = 24 * 3_600_000;

/** The day before a time's UTC day, which ended last, from its start to its end. */
function lastEndedDay(now: Date): { day: string; from: Date; until: Date } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(until.getTime() - DAY_MS);
  return { day: from.toISOString().slice(0, 10), from, until };
}

/**
 * The start of the first day a user's next digest covers: the day after the
 * last day their latest digest covered, or the first of the 7 latest ended
 * days, whichever is later; the end of the day that ended last when they have
 * a digest for it already.
 */
function coverageStart(lastCovered: string | null, until: Date): Date {
  const earliest = new Date(until.getTime() - DIGEST_DAYS * DAY_MS);
  if (lastCovered === null) return earliest;
  const after = new Date(Date.parse(`${lastCovered}T00:00:00Z`) + DAY_MS);
  return after > earliest ? after : earliest;
}

/** A digest to send: to whom, what it says, and the first day it covers. */
interface Digest {
  userId: string;
  email: string;
  /** The first UTC day it covers, YYYY-MM-DD. */
  firstDay: string;
  /** The days it covers, the first and the last, as its subject and text name them. */
  days: ReturnType<typeof serverDays>;
  /** Its updates, by request. */
  byRequest: DigestRequest[];
  more: number;
  updates: number;
}

/**
 * The digests to send now: one per member with the digest on and an address,
 * with none yet for the day that ended last, that has updates in the days
 * since their last digest, at most the 7 latest.
 */
async function digestsOf(context: OrgContext, { until, installUrl }: { until: Date; installUrl: string }): Promise<Digest[]> {
  const { tx, orgId } = context;
  const recipients = await tx
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(members, and(eq(members.orgId, users.orgId), eq(members.userId, users.id)))
    .where(and(eq(users.orgId, orgId), eq(users.digestEnabled, true), isNotNull(users.email)))
    .orderBy(asc(users.id));
  const lastCovered = new Map(
    (
      await tx
        .select({ userId: digestRecords.userId, day: max(digestRecords.day) })
        .from(digestRecords)
        .where(eq(digestRecords.orgId, orgId))
        .groupBy(digestRecords.userId)
    ).map(({ userId, day }) => [userId, day]),
  );
  const digests: Digest[] = [];
  for (const { userId, email } of recipients) {
    if (email === null) continue;
    const from = coverageStart(lastCovered.get(userId) ?? null, until);
    // The day that ended last is covered already.
    if (from >= until) continue;
    const { events, more } = await updatesBetween(context, { userId, scope: "whats_new", readers: "people", from, until, limit: 5_000 });
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
    // From the first day it covers to the day that ended last.
    const lastDay = new Date(until.getTime() - DAY_MS);
    const days = serverDays(from, lastDay);
    // Over more than one day, each update's time names its day.
    const withDay = serverDay(from) !== serverDay(lastDay);
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
      request.updates.push({ at: updateTime(update.occurredAt, { withDay }), type: eventTypeText(update.type), said: updateSaid(update) });
    }
    const beyond = kept.length - listed.length + (more ? 1 : 0);
    digests.push({ userId, email, firstDay: serverDay(from), days, byRequest: [...byRequest.values()], more: beyond, updates: kept.length });
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
    const { day, until } = lastEndedDay(now());
    let digests: Digest[];
    try {
      digests = await withOrg(database, (context) => digestsOf(context, { until, installUrl }), { readOnly: true });
    } catch (error) {
      // Before setup there is no org, and so nobody to email.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const digest of digests) {
      const { userId, updates, firstDay, days } = digest;
      await withOrg(database, async ({ tx, orgId }) => {
        const recorded = await tx
          .insert(digestRecords)
          .values({ orgId, userId, day, firstDay, sentAt: now(), updates })
          .onConflictDoNothing()
          .returning({ userId: digestRecords.userId });
        // Another run recorded it first, and sends it.
        if (recorded.length === 0) return;
        await mailer.send(digest.email, DIGEST, {
          days,
          text: digestText({
            days,
            byRequest: digest.byRequest,
            more: digest.more,
            inbox: installLink(installUrl, INBOX_PATH),
            settings: installLink(installUrl, EMAIL_SETTINGS_PATH),
          }),
        });
      });
    }
  },
};
