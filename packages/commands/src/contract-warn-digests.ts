import type { ContractSection } from "@tiehall/catalog";
import { apis, contractChangeSets, contractReports, contractWarnDigestEmails, contractWarnDigestEntries, members, teamMembers, teams, users } from "@tiehall/db";
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { apiNameText, installLink, pullRequestText, serverDay, teamKey, WARN_DIGEST, warnDigestText } from "./email.ts";
import { EMAIL_SETTINGS_PATH } from "./email-settings-page.ts";
import { INBOX_PATH } from "./inbox-page.ts";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The daily WARN digests (contract-changes: Potentially breaking changes go to
// a daily digest; requester-loop: The web inbox; requester-loop: Email for
// people, only when SMTP is set; design.md, Decisions this change rests on:
// D28 #61, #72, #73; D29 (6); design.md, Self-hosting decisions: S10).
// WARN-level changes open no request while their API's WARN switch is off. A
// change set's update that applies a report whose changes open no request,
// because it holds no ERR-level change and the switch is off, and that holds
// WARN-level changes, records them in the daily WARN digest of each team that
// declared it consumes the API, in the update's transaction: one entry per
// change set and UTC day, which names the day's latest such report. INFO-level
// changes reach no digest, and the WARN-level changes of a report that opens
// or updates requests are listed in those requests' packets instead.
//
// A team's digest of a day is its entries of that day. Once the day has ended,
// it is listed in the standing list of the web inbox of each member of the
// team, newest day first, with each change set's API, provider pull request
// and WARN-level changes, and it stays listed. When SMTP is set, the worker's
// hourly job emails the digest of the day that ended last to each member of
// the team who has an address and the daily digest on, which also covers this
// digest, once: it records each email in the transaction that sends it, so a
// send that fails is sent again by the next run. The email names each change
// set's API, provider pull request and how many WARN-level changes it has, in
// Tiehall's words, and leads to the standing list for the changes themselves,
// which the diff engine's output in the provider's CI named.

/** The UTC day of a time, as YYYY-MM-DD. */
function dayOf(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/**
 * Records, in the update's transaction, that a report's WARN-level changes go
 * to the daily WARN digests of these consuming teams, for the UTC day of now.
 */
export async function recordWarnDigestEntries(
  { tx, orgId }: Pick<OrgContext, "tx" | "orgId">,
  entry: { changeSetId: string; reportId: string; teamIds: readonly string[]; now: Date },
): Promise<void> {
  if (entry.teamIds.length === 0) return;
  const day = dayOf(entry.now);
  await tx
    .insert(contractWarnDigestEntries)
    .values(entry.teamIds.map((teamId) => ({ orgId, teamId, changeSetId: entry.changeSetId, day, reportId: entry.reportId, recordedAt: entry.now })))
    .onConflictDoUpdate({
      target: [contractWarnDigestEntries.orgId, contractWarnDigestEntries.teamId, contractWarnDigestEntries.changeSetId, contractWarnDigestEntries.day],
      set: { reportId: sql`excluded.report_id`, recordedAt: sql`excluded.recorded_at` },
    });
}

/** A change set of a WARN digest, as the standing list shows it. */
export interface WarnDigestChangeSetView {
  api: string;
  pullRequest: { repository: string; number: number; url: string };
  untrusted: { changes: { id: string; operation: string }[] };
}

/** A team's daily WARN digest, as the standing list shows it. */
export interface WarnDigestView {
  team: { id: string; key: string };
  day: string;
  text: string;
  changeSets: WarnDigestChangeSetView[];
}

/** The entries of the digests these conditions name, with what they list, newest day first, then by team, API and pull request. */
async function digestEntries({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, where: ReturnType<typeof and>) {
  const rows = await tx
    .select({
      teamId: teams.id,
      teamKey: teams.key,
      day: contractWarnDigestEntries.day,
      api: apis.name,
      repository: apis.repositoryFullName,
      number: contractChangeSets.pullRequestNumber,
      changes: contractReports.changes,
    })
    .from(contractWarnDigestEntries)
    .innerJoin(teams, and(eq(teams.orgId, contractWarnDigestEntries.orgId), eq(teams.id, contractWarnDigestEntries.teamId)))
    .innerJoin(contractChangeSets, and(eq(contractChangeSets.orgId, contractWarnDigestEntries.orgId), eq(contractChangeSets.id, contractWarnDigestEntries.changeSetId)))
    .innerJoin(apis, and(eq(apis.orgId, contractChangeSets.orgId), eq(apis.id, contractChangeSets.apiId)))
    .innerJoin(contractReports, and(eq(contractReports.orgId, contractWarnDigestEntries.orgId), eq(contractReports.id, contractWarnDigestEntries.reportId)))
    .where(and(eq(contractWarnDigestEntries.orgId, orgId), where))
    .orderBy(desc(contractWarnDigestEntries.day), asc(teams.key), asc(apis.name), asc(contractChangeSets.pullRequestNumber));
  return rows.map((row) => ({
    ...row,
    warn: (row.changes as ContractSection["changes"]).filter(({ level }) => level === "WARN").map(({ id, operation }) => ({ id, operation })),
  }));
}

/** The WARN digests of the user's teams, of the UTC days that have ended by now, newest day first. */
export async function warnDigestViews(context: Pick<OrgContext, "tx" | "orgId">, userId: string, now: Date): Promise<WarnDigestView[]> {
  const mine = sql`EXISTS (SELECT 1 FROM ${teamMembers} m WHERE m.org_id = ${contractWarnDigestEntries.orgId} AND m.team_id = ${contractWarnDigestEntries.teamId} AND m.user_id = ${userId})`;
  const entries = await digestEntries(context, and(mine, lt(contractWarnDigestEntries.day, dayOf(now))));
  const digests: WarnDigestView[] = [];
  for (const entry of entries) {
    let digest = digests.at(-1);
    if (digest === undefined || digest.day !== entry.day || digest.team.id !== entry.teamId) {
      digest = {
        team: { id: entry.teamId, key: entry.teamKey },
        day: entry.day,
        text: `${entry.teamKey}'s WARN digest of ${entry.day} (UTC): potentially breaking changes reported that day to APIs ${entry.teamKey} declared it consumes, which open no request while each API's WARN switch is off.`,
        changeSets: [],
      };
      digests.push(digest);
    }
    digest.changeSets.push({
      api: entry.api,
      pullRequest: { repository: entry.repository, number: entry.number, url: `https://github.com/${entry.repository}/pull/${entry.number}` },
      untrusted: { changes: entry.warn },
    });
  }
  return digests;
}

/** A WARN digest email to send: to whom, for which team and day, and what it lists. */
interface UnsentWarnDigest {
  teamId: string;
  teamKey: string;
  userId: string;
  email: string;
}

/**
 * Every hour, once email is set up, emails the WARN digest of the UTC day that
 * ended last to each member of each team that has one, who has an address and
 * the daily digest on, once.
 */
export const emailWarnDigests: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("digests.email_warn", 1, {
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 1_800,
  }),
  // Hourly, so a day's digests go out soon after it ends, and a missed hour is made up at the next.
  schedule: "7 * * * *",
  async handle(_job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    const today = Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate());
    const day = dayOf(new Date(today - 24 * 3_600_000));
    let unsent: UnsentWarnDigest[];
    try {
      unsent = await withOrg(
        database,
        ({ tx, orgId }) =>
          tx
            .selectDistinct({ teamId: teams.id, teamKey: teams.key, userId: users.id, email: users.email })
            .from(contractWarnDigestEntries)
            .innerJoin(teams, and(eq(teams.orgId, contractWarnDigestEntries.orgId), eq(teams.id, contractWarnDigestEntries.teamId)))
            .innerJoin(teamMembers, and(eq(teamMembers.orgId, contractWarnDigestEntries.orgId), eq(teamMembers.teamId, contractWarnDigestEntries.teamId)))
            .innerJoin(members, and(eq(members.orgId, teamMembers.orgId), eq(members.userId, teamMembers.userId)))
            .innerJoin(users, and(eq(users.orgId, teamMembers.orgId), eq(users.id, teamMembers.userId)))
            .where(
              and(
                eq(contractWarnDigestEntries.orgId, orgId),
                eq(contractWarnDigestEntries.day, day),
                eq(users.digestEnabled, true),
                isNotNull(users.email),
                sql`NOT EXISTS (SELECT 1 FROM ${contractWarnDigestEmails} e
                                 WHERE e.org_id = ${contractWarnDigestEntries.orgId} AND e.team_id = ${contractWarnDigestEntries.teamId}
                                   AND e.user_id = ${users.id} AND e.day = ${day})`,
              ),
            )
            .orderBy(asc(teams.key), asc(users.id))
            .then((rows) => rows.map((row) => ({ ...row, email: row.email ?? "" }))),
        { readOnly: true },
      );
    } catch (error) {
      // Before setup there is no org, and so no digest.
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const digest of unsent) {
      await withOrg(database, async (context) => {
        const recorded = await context.tx
          .insert(contractWarnDigestEmails)
          .values({ orgId: context.orgId, teamId: digest.teamId, userId: digest.userId, day, sentAt: now() })
          .onConflictDoNothing()
          .returning({ userId: contractWarnDigestEmails.userId });
        // Another run recorded it first, and sends it.
        if (recorded.length === 0) return;
        const entries = await digestEntries(context, and(eq(contractWarnDigestEntries.teamId, digest.teamId), eq(contractWarnDigestEntries.day, day)));
        const dayText = serverDay(new Date(`${day}T00:00:00Z`));
        await mailer.send(digest.email, WARN_DIGEST, {
          team: teamKey(digest.teamKey),
          day: dayText,
          text: warnDigestText({
            team: teamKey(digest.teamKey),
            day: dayText,
            changeSets: entries.map((entry) => {
              const pr = pullRequestText(entry.repository, entry.number);
              return { api: apiNameText(entry.api), pullRequest: pr.name, url: pr.url, changes: entry.warn.length };
            }),
            inbox: installLink(installUrl, INBOX_PATH),
            settings: installLink(installUrl, EMAIL_SETTINGS_PATH),
          }),
        });
      });
    }
  },
};
