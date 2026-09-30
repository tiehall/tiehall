import { members, personalAccessTokenReminders, personalAccessTokens, users } from "@tiehall/db";
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { dayCount, installLink, PERSONAL_ACCESS_TOKEN_REMINDER, personalAccessTokenReminderSentence, serverDay } from "./email.ts";
import { defineJobType } from "./jobs.ts";
import { TOKENS_PATH } from "./personal-access-tokens.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// PAT owners are reminded before expiry (agent-access: PAT owners are reminded
// before expiry; requester-loop: The web inbox; self-host-install: Optional
// email through SMTP; design.md, Decisions this change rests on: D28 #46;
// design.md, Self-hosting decisions: S10).
//
// A job that runs every hour reminds the owner of each personal access token
// that may still be used, and whose owner is still a member, on the UTC day 14
// days before the UTC day the token expires, and again on the day 3 days
// before: a token that expires on 2026-12-31 is reminded of on 2026-12-17 and
// on 2026-12-28. A reminder whose day has come and that the token has not had
// yet is made at the job's first run from that day on, so a worker that was
// stopped catches up; a token created after a reminder's day gets no such
// reminder. Each reminder is made once, and:
// - is listed in the standing list of its owner's web inbox, in Tiehall's own
//   words, while the token may still be used: until it expires or is revoked;
// - is emailed to its owner once, to their GitHub primary verified email, when
//   SMTP is set up; without SMTP it stays in the web inbox alone.
// Neither says the token's label, which is the owner's own text, nor its value.

/** The days before a token's expiry day on which its owner is reminded. */
export const REMINDER_DAYS_BEFORE = [14, 3] as const;

/** A reminder as the standing list of the web inbox shows it. */
export interface PersonalAccessTokenReminderView {
  id: string;
  tokenId: string;
  daysBefore: number;
  /** What the reminder says, in Tiehall's words. */
  text: string;
  /** When the token expires. */
  expiresAt: string;
  createdAt: string;
}

/** What a reminder says in the web inbox: the sentence the email opens with, and where to go. */
function reminderText(reminder: { daysBefore: number; tokenCreatedAt: Date; expiresAt: Date }): string {
  const sentence = personalAccessTokenReminderSentence({
    createdOn: serverDay(reminder.tokenCreatedAt),
    expiresOn: serverDay(reminder.expiresAt),
    days: dayCount(reminder.daysBefore),
  });
  return `${sentence} Create a new one on your Connected agents and tokens page before then.`;
}

/** The user's reminders of tokens that may still be used, oldest first, as the standing list shows them. */
export async function personalAccessTokenReminderViews({ tx, orgId }: OrgContext, userId: string, now: Date): Promise<PersonalAccessTokenReminderView[]> {
  const rows = await tx
    .select({
      id: personalAccessTokenReminders.id,
      tokenId: personalAccessTokenReminders.tokenId,
      daysBefore: personalAccessTokenReminders.daysBefore,
      createdAt: personalAccessTokenReminders.createdAt,
      tokenCreatedAt: personalAccessTokens.createdAt,
      expiresAt: personalAccessTokens.expiresAt,
    })
    .from(personalAccessTokenReminders)
    .innerJoin(
      personalAccessTokens,
      and(eq(personalAccessTokens.orgId, personalAccessTokenReminders.orgId), eq(personalAccessTokens.id, personalAccessTokenReminders.tokenId)),
    )
    .where(
      and(
        eq(personalAccessTokenReminders.orgId, orgId),
        eq(personalAccessTokenReminders.userId, userId),
        isNull(personalAccessTokens.revokedAt),
        gt(personalAccessTokens.expiresAt, now),
      ),
    )
    .orderBy(asc(personalAccessTokenReminders.createdAt), asc(personalAccessTokenReminders.daysBefore));
  return rows.map((row) => ({
    id: row.id,
    tokenId: row.tokenId,
    daysBefore: row.daysBefore,
    text: reminderText(row),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Makes, in the caller's transaction, every reminder whose day has come by
 * `now` and that a token that may still be used, of a member, has not had yet.
 */
async function makeDueReminders({ tx, orgId }: OrgContext, now: Date): Promise<void> {
  for (const daysBefore of REMINDER_DAYS_BEFORE) {
    await tx.execute(sql`
      INSERT INTO personal_access_token_reminders (org_id, token_id, user_id, days_before, created_at)
      SELECT t.org_id, t.id, t.user_id, ${daysBefore}, ${now}
        FROM personal_access_tokens t
       WHERE t.org_id = ${orgId} AND t.revoked_at IS NULL AND t.expires_at > ${now}
         AND EXISTS (SELECT 1 FROM members m WHERE m.org_id = t.org_id AND m.user_id = t.user_id)
         AND (t.expires_at AT TIME ZONE 'UTC')::date - ${daysBefore}::int <= (${now}::timestamptz AT TIME ZONE 'UTC')::date
         AND (t.created_at AT TIME ZONE 'UTC')::date <= (t.expires_at AT TIME ZONE 'UTC')::date - ${daysBefore}::int
      ON CONFLICT (org_id, token_id, days_before) DO NOTHING`);
  }
}

/** A reminder to email: to whom, and the values its email holds. */
interface UnsentReminder {
  id: string;
  email: string;
  daysBefore: number;
  tokenCreatedAt: Date;
  expiresAt: Date;
}

/** Every hour, makes the reminders whose day has come, and, once email is set up, emails each one not emailed yet. */
export const remindPersonalAccessTokenOwners: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("personal_access_tokens.remind", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "17 * * * *",
  async handle(_job, { database, now, mailer, installUrl }) {
    let unsent: UnsentReminder[];
    try {
      unsent = await withOrg(database, async (context) => {
        await makeDueReminders(context, now());
        if (mailer === undefined || !mailer.configured || installUrl === undefined) return [];
        const rows = await context.tx
          .select({
            id: personalAccessTokenReminders.id,
            email: users.email,
            daysBefore: personalAccessTokenReminders.daysBefore,
            tokenCreatedAt: personalAccessTokens.createdAt,
            expiresAt: personalAccessTokens.expiresAt,
          })
          .from(personalAccessTokenReminders)
          .innerJoin(
            personalAccessTokens,
            and(eq(personalAccessTokens.orgId, personalAccessTokenReminders.orgId), eq(personalAccessTokens.id, personalAccessTokenReminders.tokenId)),
          )
          .innerJoin(users, and(eq(users.orgId, personalAccessTokenReminders.orgId), eq(users.id, personalAccessTokenReminders.userId)))
          .innerJoin(members, and(eq(members.orgId, personalAccessTokenReminders.orgId), eq(members.userId, personalAccessTokenReminders.userId)))
          .where(
            and(
              eq(personalAccessTokenReminders.orgId, context.orgId),
              isNull(personalAccessTokenReminders.emailedAt),
              isNotNull(users.email),
              isNull(personalAccessTokens.revokedAt),
              gt(personalAccessTokens.expiresAt, now()),
            ),
          )
          .orderBy(asc(personalAccessTokenReminders.createdAt), asc(personalAccessTokenReminders.daysBefore));
        return rows.map((row) => ({ ...row, email: row.email ?? "" }));
      });
    } catch (error) {
      // Before setup there is no org, and so no token.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    if (mailer === undefined || installUrl === undefined) return;
    for (const reminder of unsent) {
      await mailer.send(reminder.email, PERSONAL_ACCESS_TOKEN_REMINDER, {
        createdOn: serverDay(reminder.tokenCreatedAt),
        expiresOn: serverDay(reminder.expiresAt),
        days: dayCount(reminder.daysBefore),
        page: installLink(installUrl, TOKENS_PATH),
      });
      await withOrg(database, ({ tx, orgId }) =>
        tx
          .update(personalAccessTokenReminders)
          .set({ emailedAt: now() })
          .where(and(eq(personalAccessTokenReminders.orgId, orgId), eq(personalAccessTokenReminders.id, reminder.id))),
      );
    }
  },
};
