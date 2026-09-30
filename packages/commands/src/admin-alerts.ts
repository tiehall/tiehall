import { getBanners, type banner } from "@tiehall/catalog";
import { adminAlertEmails, githubApp, members, users } from "@tiehall/db";
import { and, eq, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import { GITHUB_WEBHOOK_ALERT, installLink, type ServerText } from "./email.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { defineJobType } from "./jobs.ts";
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
// The problem built so far: Tiehall gave up a GitHub webhook delivery
// (github-redelivery.ts), which the App's row records until an admin switches
// GitHub's mode or a delivery that reaches the install after the give-up is
// verified. Teams map no GitHub intake repository yet, so its banner shows to
// the admins alone; the members of the teams whose mirrors go through GitHub
// see it once the GitHub Issues mirror maps teams (group 24). The write that
// records the give-up when none is recorded starts the email to the admins
// (github-mode.ts), so later give-ups while the banner shows start none.

export type Banner = z.output<typeof banner>;

/** The admin alerts that are emailed, by their ids. */
export type AdminAlert = "github_webhook";

/** The problem with GitHub's webhook that the App's row shows, if any: when it was raised, and whether GitHub moved to polling mode. */
async function githubWebhookProblem({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">): Promise<{ raisedAt: Date; polling: boolean } | undefined> {
  const [row] = await tx
    .select({ raisedAt: githubApp.webhookGivenUpAt, mode: githubApp.mode })
    .from(githubApp)
    .where(and(eq(githubApp.orgId, orgId), isNotNull(githubApp.webhookGivenUpAt)));
  return row?.raisedAt === null || row?.raisedAt === undefined ? undefined : { raisedAt: row.raisedAt, polling: row.mode === "polling" };
}

/** What the banner and the email say about the mode after a given-up delivery. */
function pollingSentence(polling: boolean): string {
  return polling
    ? "GitHub now runs in polling mode, so its changes still reach Tiehall, within 2 minutes."
    : "An admin chose webhook mode, so GitHub stays in it, and changes reach Tiehall only through the reconciliation every 15 minutes until deliveries work again.";
}

/** The banners the web UI shows the member this call acts for: every one to an admin. */
export async function bannersFor(context: Pick<OrgContext, "tx" | "orgId">, role: string | undefined): Promise<Banner[]> {
  const banners: Banner[] = [];
  const webhook = await githubWebhookProblem(context);
  if (webhook !== undefined && role === "admin") {
    banners.push({
      id: "github_webhook",
      text:
        "GitHub's webhook deliveries to this install fail: Tiehall gave one up after asking GitHub 5 times to deliver it again. " +
        `${pollingSentence(webhook.polling)} Check the webhook in the App's settings on GitHub, on its Advanced tab.`,
      link: { href: "/admin/github", text: "The GitHub page of the admin UI" },
    });
  }
  return banners;
}

export const ADMIN_ALERT_HANDLERS: Handlers = {
  [getBanners.id]: defineHandler(getBanners, async (_input, context) => ({ banners: await bannersFor(context, context.member?.role) })),
};

export interface AdminAlertEmailData extends Record<string, unknown> {
  alert: AdminAlert;
  /** When the alert was raised, as the state that shows it records it. */
  raisedAt: string;
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
    let polling: boolean;
    try {
      const read = await withOrg(
        database,
        async (context) => {
          const problem = await githubWebhookProblem(context);
          if (problem === undefined || problem.raisedAt.getTime() !== raisedAt.getTime()) return undefined;
          const admins = await context.tx
            .select({ userId: members.userId, email: users.email })
            .from(members)
            .innerJoin(users, and(eq(users.orgId, members.orgId), eq(users.id, members.userId)))
            .where(and(eq(members.orgId, context.orgId), eq(members.role, "admin"), isNotNull(users.email)));
          return { polling: problem.polling, admins: admins.flatMap(({ userId, email }) => (email === null ? [] : [{ userId, email }])) };
        },
        { readOnly: true },
      );
      if (read === undefined) return;
      recipients = read.admins;
      polling = read.polling;
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
        await mailer.send(email, GITHUB_WEBHOOK_ALERT, { page: installLink(installUrl, "/admin/github"), polling: pollingSentence(polling) as ServerText });
      });
    }
  },
};
