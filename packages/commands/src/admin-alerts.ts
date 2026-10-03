import { getBanners, type banner } from "@tiehall/catalog";
import { adminAlertEmails, githubApp, githubConnectedInstallations, githubCoveredRepositories, githubInstallations, members, teamMembers, teams, trackerMappings, users } from "@tiehall/db";
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { fanOutBanner, waitingFanOuts } from "./contract-fan-out.ts";
import {
  apiNameText,
  brokenInstallationsSentence,
  CONTRACT_FAN_OUT_ALERT,
  countText,
  GITHUB_INSTALLATION_ALERT,
  GITHUB_WEBHOOK_ALERT,
  githubModeSentence,
  installLink,
  repositoryText,
  teamKeysText,
  type Mailer,
} from "./email.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
import type { Member } from "./members.ts";
import { mirrorFailureBanners } from "./mirror-failures.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";

// The admin alerts (tracker-mirrors: Broken integrations are surfaced;
// design.md, Decisions this change rests on: D28 #41, #83;
// github-layer-hardening: design.md, Technical decisions: T8). A problem with
// an integration shows as a banner in the web UI, on the admin page and the
// home page, to the install's admins and to the members of each team whose
// mirrors go through that integration, and to no one else; with SMTP set,
// every admin also gets one email about it while its banner shows. A banner
// is read from the state that shows the problem, so it goes on its own once
// the problem does.
//
// The problems built so far:
// - Tiehall gave up a GitHub webhook delivery (github-redelivery.ts), which
//   the App's row records until an admin switches GitHub's mode or a delivery
//   that reaches the install after the give-up is verified. Its banner shows
//   to the admins and to the members of each team that maps a GitHub intake
//   repository. The write that records the give-up when none is recorded
//   starts the email to the admins (github-mode.ts), so later give-ups while
//   the banner shows start none.
// - A connected installation of the install's GitHub App is suspended or
//   deleted on GitHub, as the latest listing of the App's installations, or a
//   delivery about it, recorded (github-installations.ts). Its banner shows
//   to the admins and to the members of each team whose intake repository is
//   one the installation covered, until a listing finds it working again, or
//   an admin disconnects it. The listing that records it broken starts the
//   email, once per time it broke.
// An admin's banner leads to the page of the admin UI that fixes the
// problem; a member's, which they cannot open, to the members page, which
// names the admins. An App created without a webhook has no delivery log,
// and GitHub's 404 for it raises nothing (github-mode.ts).
//
// The admins and the members of a request's target team also see a banner,
// with a Retry button, for each of the team's requests whose mirror job failed
// until it moved to the dead-letter queue (tracker-mirrors: Failed mirror
// jobs are shown with a Retry button; mirror-failures.ts); it sends no email.
//
// The admins also see a banner for each contract-change fan-out that waits for
// an admin's confirmation (agent-safety: One PR reaches at most 10 consumer
// teams without an admin; contract-fan-out.ts), which leads to the review page
// of the confirmation, and get one email about it when SMTP is set; the update
// that makes the first team of a change set wait starts that email.

export type Banner = z.output<typeof banner>;

/** The admin alerts that are emailed, by their ids. */
export type AdminAlert = "github_webhook" | "contract_fan_out" | "github_installation";

/** The problem with GitHub's webhook that the App's row shows, if any: when it was raised, and whether GitHub moved to polling mode. */
async function githubWebhookProblem({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<{ raisedAt: Date; polling: boolean } | undefined> {
  const [row] = await tx
    .select({ raisedAt: githubApp.webhookGivenUpAt, mode: githubApp.mode })
    .from(githubApp)
    .where(and(eq(githubApp.orgId, orgId), isNotNull(githubApp.webhookGivenUpAt)));
  return row?.raisedAt === null || row?.raisedAt === undefined ? undefined : { raisedAt: row.raisedAt, polling: row.mode === "polling" };
}

/** A connected installation of the App in use that is suspended or deleted on GitHub, with the teams whose mirrors go through it. */
interface BrokenInstallation {
  id: string;
  account: string;
  deleted: boolean;
  /** When it broke: when it was deleted, or else when GitHub suspended it. */
  raisedAt: Date;
  /** The teams whose intake repository is one it covered, with that repository. */
  teams: { id: string; key: string; repository: string }[];
}

/** The connected installations of the App in use that are suspended or deleted on GitHub, by account. */
async function brokenInstallations({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<BrokenInstallation[]> {
  const [app] = await tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, orgId));
  if (app === undefined) return [];
  const rows = await tx
    .select({ id: githubInstallations.id, account: githubInstallations.accountLogin, suspendedAt: githubInstallations.suspendedAt, deletedAt: githubInstallations.deletedAt })
    .from(githubInstallations)
    .innerJoin(
      githubConnectedInstallations,
      and(eq(githubConnectedInstallations.orgId, githubInstallations.orgId), eq(githubConnectedInstallations.installationId, githubInstallations.id)),
    )
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.appId, app.appId),
        or(isNotNull(githubInstallations.suspendedAt), isNotNull(githubInstallations.deletedAt)),
      ),
    )
    .orderBy(asc(githubInstallations.accountLogin), asc(githubInstallations.installationId));
  const broken: BrokenInstallation[] = [];
  for (const { id, account, suspendedAt, deletedAt } of rows) {
    // The repositories it covered stay recorded while it is broken: the teams that map one of them mirror through it.
    const mapped = await tx
      .select({ id: teams.id, key: teams.key, repository: trackerMappings.targetName })
      .from(trackerMappings)
      .innerJoin(teams, and(eq(teams.orgId, trackerMappings.orgId), eq(teams.id, trackerMappings.teamId)))
      .innerJoin(
        githubCoveredRepositories,
        and(
          eq(githubCoveredRepositories.orgId, trackerMappings.orgId),
          eq(githubCoveredRepositories.installationId, id),
          sql`${githubCoveredRepositories.repositoryId}::text = ${trackerMappings.target}`,
        ),
      )
      .where(and(eq(trackerMappings.orgId, orgId), eq(trackerMappings.tracker, "github")))
      .orderBy(asc(teams.key));
    broken.push({ id, account, deleted: deletedAt !== null, raisedAt: (deletedAt ?? suspendedAt)!, teams: mapped });
  }
  return broken;
}

/** The ids of the teams that map a GitHub intake repository, whose mirrors go through GitHub. */
async function teamsMirroringThroughGitHub({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<Set<string>> {
  const rows = await tx
    .select({ teamId: trackerMappings.teamId })
    .from(trackerMappings)
    .where(and(eq(trackerMappings.orgId, orgId), eq(trackerMappings.tracker, "github")));
  return new Set(rows.map(({ teamId }) => teamId));
}

/** The ids of the member's teams. */
async function teamsOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, userId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId)));
  return new Set(rows.map(({ teamId }) => teamId));
}

/** Where an admin's banner about GitHub leads: the page of the admin UI that fixes it. */
const GITHUB_PAGE = { href: "/admin/github", text: "The GitHub page of the admin UI" };

/** Where a member's banner leads, since they cannot open the admin UI: the members page, which names the admins. */
const ADMINS = { href: "/members", text: "The members page, which names the admins" };

/** What a broken installation's banner says, to an admin or to a member. */
function brokenInstallationText(installation: BrokenInstallation, admin: boolean): string {
  const { account, deleted } = installation;
  const repositories = installation.teams.map(({ key, repository }) => `${key} in ${repository}`);
  const what = deleted ? `The ${account} installation of the install's GitHub App was deleted on GitHub` : `The ${account} installation of the install's GitHub App is suspended on GitHub`;
  const effect =
    `, so Tiehall cannot read the repositories it covered, link or close requests through their pull requests, or write the mirror issues in them` +
    (repositories.length === 0 ? "." : `: the mirrors of ${repositories.join(", ")}.`);
  const fix = !admin
    ? " An admin of the install can tell you more."
    : deleted
      ? ` An owner of ${account} installs the App again on GitHub, and an admin connects the new installation.`
      : ` An owner of ${account} unsuspends it in ${account}'s settings on GitHub, under GitHub Apps.`;
  return `${what}${effect}${fix}`;
}

/** The banners the web UI shows the member this call acts for: every one to an admin. */
export async function bannersFor(context: Pick<OrgContext, "tx" | "orgId">, member: Pick<Member, "userId" | "role"> | undefined): Promise<Banner[]> {
  const role = member?.role;
  const admin = role === "admin";
  const banners: Banner[] = [];
  if (member === undefined) return banners;
  const mine = admin ? new Set<string>() : await teamsOf(context, member.userId);
  const sees = (teamIds: Iterable<string>) => admin || [...teamIds].some((id) => mine.has(id));
  const webhook = await githubWebhookProblem(context);
  if (webhook !== undefined && sees(await teamsMirroringThroughGitHub(context))) {
    banners.push({
      id: "github_webhook",
      text:
        "GitHub's webhook deliveries to this install fail: Tiehall gave one up after asking GitHub 5 times to deliver it again. " +
        `${githubModeSentence(webhook.polling)} ` +
        (admin ? "Check the webhook in the App's settings on GitHub, on its Advanced tab." : "An admin of the install can check the webhook in the App's settings on GitHub."),
      link: admin ? GITHUB_PAGE : ADMINS,
    });
  }
  for (const installation of await brokenInstallations(context)) {
    if (!sees(installation.teams.map(({ id }) => id))) continue;
    banners.push({ id: `github_installation:${installation.id}`, text: brokenInstallationText(installation, admin), link: admin ? GITHUB_PAGE : ADMINS });
  }
  if (admin) for (const fanOut of await waitingFanOuts(context)) banners.push(fanOutBanner(fanOut));
  banners.push(...(await mirrorFailureBanners(context, member)));
  return banners;
}

export const ADMIN_ALERT_HANDLERS: Handlers = {
  [getBanners.id]: defineHandler(getBanners, async (_input, context) => ({ banners: await bannersFor(context, context.member) })),
};

export interface AdminAlertEmailData extends Record<string, unknown> {
  alert: AdminAlert;
  /** When the alert was raised, as the state that shows it records it. */
  raisedAt: string;
  /** For a waiting fan-out, its change set. */
  changeSetId?: string;
}

/** An alert's email, which sends it to one admin; read from the state that shows the alert. */
type AlertEmail = (mailer: Mailer, to: string, installUrl: string) => Promise<unknown>;

/** The email of an alert, while its banner shows the raise the job was started for; undefined once its banner has gone or shows a later raise. */
async function alertEmailOf(context: Pick<OrgContext, "tx" | "orgId">, data: AdminAlertEmailData, raisedAt: Date): Promise<AlertEmail | undefined> {
  if (data.alert === "github_installation") {
    // The installations that broke at this time and still are broken from then.
    const broken = (await brokenInstallations(context)).filter((installation) => installation.raisedAt.getTime() === raisedAt.getTime());
    if (broken.length === 0) return undefined;
    const suspended = broken.filter(({ deleted }) => !deleted).map(({ account }) => account);
    const deleted = broken.filter(({ deleted: gone }) => gone).map(({ account }) => account);
    return (mailer, to, installUrl) =>
      mailer.send(to, GITHUB_INSTALLATION_ALERT, { broken: brokenInstallationsSentence({ suspended, deleted }), page: installLink(installUrl, "/admin/github") });
  }
  if (data.alert === "github_webhook") {
    const problem = await githubWebhookProblem(context);
    if (problem === undefined || problem.raisedAt.getTime() !== raisedAt.getTime()) return undefined;
    return (mailer, to, installUrl) =>
      mailer.send(to, GITHUB_WEBHOOK_ALERT, { page: installLink(installUrl, "/admin/github"), polling: githubModeSentence(problem.polling) });
  }
  if (data.changeSetId === undefined) return undefined;
  const [fanOut] = await waitingFanOuts(context, data.changeSetId);
  if (fanOut === undefined || fanOut.since.getTime() !== raisedAt.getTime()) return undefined;
  return (mailer, to, installUrl) =>
    mailer.send(to, CONTRACT_FAN_OUT_ALERT, {
      count: countText(fanOut.teams.length),
      repository: repositoryText(fanOut.repository),
      number: countText(fanOut.pullRequestNumber),
      api: apiNameText(fanOut.api),
      teams: teamKeysText(fanOut.teams.map(({ key }) => key)),
      page: installLink(installUrl, "/admin"),
    });
}

/**
 * The job that emails every admin about an alert once, started in the write
 * that raised it. Without SMTP settings it sends nothing, and the banner is the
 * only alert. It sends nothing for an alert whose banner has gone, or one
 * raised again since, whose own job emails about it; and it records each admin
 * it emails in the transaction that sends the email, so a retried job emails
 * nobody twice.
 */
export const emailAdminAlerts: WorkerJob<AdminAlertEmailData> = {
  type: defineJobType<AdminAlertEmailData>("admin_alerts.email", 1, {
    retryLimit: 5,
    retryDelaySeconds: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  }),
  async handle(job, { database, now, mailer, installUrl }) {
    if (mailer === undefined || !mailer.configured || installUrl === undefined) return;
    const raisedAt = new Date(job.data.raisedAt);
    let recipients: { userId: string; email: string }[];
    let alert: AlertEmail;
    try {
      const read = await withOrg(
        database,
        async (context) => {
          const email = await alertEmailOf(context, job.data, raisedAt);
          if (email === undefined) return undefined;
          const admins = await context.tx
            .select({ userId: members.userId, email: users.email })
            .from(members)
            .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
            .where(and(eq(members.orgId, context.orgId), eq(members.role, "admin"), isNotNull(users.email)));
          return { email, admins: admins.flatMap(({ userId, email: address }) => (address === null ? [] : [{ userId, email: address }])) };
        },
        { readOnly: true },
      );
      if (read === undefined) return;
      recipients = read.admins;
      alert = read.email;
    } catch (error) {
      if (error instanceof SetupRequiredError) return;
      throw error;
    }
    for (const { userId, email } of recipients) {
      await withOrg(database, async ({ tx, orgId }) => {
        const recorded = await tx
          .insert(adminAlertEmails)
          .values({ orgId, alert: job.data.alert, raisedAt, userId, sentAt: now() })
          .onConflictDoNothing()
          .returning({ userId: adminAlertEmails.userId });
        // Another run recorded it first, and sends it.
        if (recorded.length === 0) return;
        await alert(mailer, email, installUrl);
      });
    }
  },
};
