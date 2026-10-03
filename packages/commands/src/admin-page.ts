import { getBanners, getGitHubIntegration, getInstallStatus, listGitHubInstallations, type githubInstallation } from "@tiehall/catalog";
import type { z } from "zod";
import type { Banner } from "./admin-alerts.ts";
import type { EmailStatus } from "./email.ts";
import { GITHUB_ADMIN_PATH } from "./github-admin-route.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { ADMIN_PATH, adminNav } from "./admin-pages.ts";
import type { RunningVersion } from "./running-version.ts";
import { createPageRoute, htmlAnswer, link, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The admin page at /admin, the first page of the admin UI (self-host-install:
// The admin page warns about missing backups; design.md, Self-hosting
// decisions: S11 and S12). It shows when the last backup finished, as
// backup.sh recorded it on the host, and warns when none has finished yet or
// none in the last 7 days, with what to do about it. It reads through
// execute(), as the signed-in user's web session, in a read-only transaction,
// and changes nothing; a browser without a session is sent to sign in first
// (D28 #66). It also shows the running version with a link to its source
// (self-host-install: The running version links to its source;
// running-version.ts), the state of the integrations (tracker-mirrors: GitHub
// and Jira each run in webhook mode or polling mode; self-host-install:
// Optional email through SMTP): how GitHub's changes reach Tiehall, webhook or
// polling, the installations Tiehall acts on, whether a Jira site is
// connected and whether email is set up; and, first, the banners about
// problems with the integrations (admin-alerts.ts). The integrations are an
// admin's to read, so the page is an admin's: a member gets 403 and no state.

export interface AdminRouteOptions extends PageRouteOptions {
  /** The running version and the link to its source; the page shows no version without it. */
  version?: RunningVersion;
  /** Whether email is set up, from the install's SMTP settings, never its login; the page says nothing of email without it. */
  email?: EmailStatus;
}

type Integration = z.output<typeof getGitHubIntegration.output>;
type Installation = z.output<typeof githubInstallation>;

type InstallStatus = z.output<typeof getInstallStatus.output>;

/** What to do when backups are missing, as the admin page says it. */
const BACKUP_ADVICE = "Run backup.sh on the host every day and before every upgrade, and copy the dumps off the host.";

/** A time as the admin page shows it: the date, and the hour and minute, in UTC. */
function utcTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function daysAgoText(days: number): string {
  if (days === 0) return "less than a day ago";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The backups section: the last backup, and the warning when none has finished, or none in the last 7 days. */
function backupsSection({ lastBackup, backupWarning }: InstallStatus): string[] {
  const lines = ["      <h2>Backups</h2>"];
  if (lastBackup === null) {
    lines.push(`      <p><strong>${escapeHtml("No backup has finished yet.")}</strong> ${escapeHtml(BACKUP_ADVICE)}</p>`);
    return lines;
  }
  lines.push(`      <p>${escapeHtml(`The last backup finished at ${utcTime(lastBackup.finishedAt)}, ${daysAgoText(lastBackup.daysAgo)}: ${lastBackup.file}.`)}</p>`);
  if (backupWarning === "stale") {
    lines.push(`      <p><strong>${escapeHtml("No backup has finished in the last 7 days.")}</strong> ${escapeHtml(BACKUP_ADVICE)}</p>`);
  }
  return lines;
}

/** The version section: which version runs, and where its source is. */
function versionSection(version: RunningVersion | undefined): string[] {
  if (version === undefined) return [];
  return [
    "      <h2>Version</h2>",
    `      <p>${escapeHtml(`Tiehall ${version.version} is running.`)} Its source: ${link(version.sourceUrl, version.sourceUrl)}</p>`,
    `      <p>${escapeHtml("To upgrade, back up, set the new TIEHALL_IMAGE in .env and run docker compose pull && docker compose up -d; the release notes of each release say what it changes.")}</p>`,
  ];
}

/**
 * The banners, first on the page, each with the page that says more, and its
 * button, such as Retry for a failed mirror job: a form that posts the
 * button's fields to its path on the install, with the session's CSRF token
 * and the page to lead back to.
 */
export function bannersSection(banners: readonly Banner[], form: { csrf: string; back: string }): string[] {
  if (banners.length === 0) return [];
  return [
    '      <section aria-label="Alerts">',
    ...banners.flatMap((banner) => [
      `        <p><strong>${escapeHtml(banner.text)}</strong> ${link(banner.link.href, banner.link.text)}</p>`,
      ...(banner.button === undefined ? [] : bannerForm(banner.button, form)),
    ]),
    "      </section>",
  ];
}

/** A banner's button, as a form that posts to the install. */
function bannerForm(button: NonNullable<Banner["button"]>, form: { csrf: string; back: string }): string[] {
  return [
    `        <form method="post" action="${escapeHtml(button.action)}">`,
    `          <input type="hidden" name="csrf" value="${escapeHtml(form.csrf)}">`,
    ...Object.entries(button.fields).map(([name, value]) => `          <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`),
    `          <input type="hidden" name="back" value="${escapeHtml(form.back)}">`,
    `          <button type="submit">${escapeHtml(button.label)}</button>`,
    "        </form>",
  ];
}

/** Where an installation is installed, in a few words. */
function accountText({ account, accountType }: Installation): string {
  return `${account}, ${accountType === "Organization" ? "the organization" : "the personal account"}`;
}

/** What a connected installation covers, as GitHub last reported it. */
function coversText(installation: Installation): string {
  if (installation.deleted) return "deleted on GitHub: it covers no repository";
  if (installation.suspended) return "suspended on GitHub: it covers no repository until it is unsuspended";
  const count = installation.repositories.length;
  return `covering ${count === 1 ? "1 repository" : `${count} repositories`}`;
}

/** The GitHub section: the mode, the connected installations, and the page that changes them. */
function githubSection(integration: Integration, installations: readonly Installation[]): string[] {
  const lines = ["      <h2>GitHub</h2>"];
  if (integration.app === null) return [...lines, "      <p>The install has no GitHub App yet.</p>"];
  lines.push(
    `      <p>${escapeHtml(
      integration.app.mode === "webhook"
        ? "GitHub runs in webhook mode: GitHub delivers each change to the install as it happens."
        : "GitHub runs in polling mode: Tiehall asks GitHub for changes every 60 seconds, so a change reaches it within 2 minutes.",
    )}</p>`,
  );
  const connected = installations.filter(({ connected: isConnected }) => isConnected);
  const waiting = installations.filter(({ connected: isConnected, deleted }) => !isConnected && !deleted);
  if (connected.length === 0) lines.push("      <p>No installation of the App is connected, so no repository counts as covered.</p>");
  else lines.push("      <ul>", ...connected.map((installation) => `        <li>${escapeHtml(`Connected: ${accountText(installation)}, ${coversText(installation)}.`)}</li>`), "      </ul>");
  if (waiting.length > 0) {
    lines.push(`      <p>${escapeHtml(`${waiting.length === 1 ? "1 installation" : `${waiting.length} installations`} of the App ${waiting.length === 1 ? "is" : "are"} not connected; Tiehall ignores ${waiting.length === 1 ? "it" : "them"} until an admin connects ${waiting.length === 1 ? "it" : "them"}.`)}</p>`);
  }
  lines.push(`      <p>${link(GITHUB_ADMIN_PATH, "The GitHub page")} connects and disconnects installations, switches the mode and stores the webhook secret.</p>`);
  return lines;
}

/** The Jira section: no Jira site can be connected yet. */
function jiraSection(): string[] {
  return ["      <h2>Jira</h2>", "      <p>No Jira site is connected.</p>"];
}

const TLS_TEXT: Readonly<Record<string, string>> = { starttls: "with STARTTLS", tls: "over TLS", none: "without TLS" };

/** The email section: whether email is set up, and where it goes through, never the login. */
function emailSection(email: EmailStatus | undefined): string[] {
  if (email === undefined) return [];
  return [
    "      <h2>Email</h2>",
    email.configured
      ? `      <p>${escapeHtml(`Email is set up: Tiehall sends email through ${email.host}, port ${email.port} ${TLS_TEXT[email.tls] ?? ""}, from ${email.from}.`)}</p>`
      : `      <p>${escapeHtml("Email is not set up: .env holds no SMTP settings, so Tiehall sends no email, and notices stay in the web inbox and the admin banners. To send email, set the SMTP settings in .env and run docker compose up -d.")}</p>`,
  ];
}

export function createAdminRoute(options: AdminRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: ADMIN_PATH,
    name: "admin",
    async get(_query, { read, csrf }) {
      // The integrations are an admin's: a member's read of them is refused with 403, and the page shows nothing.
      const integration = await read<Integration>(getGitHubIntegration.id, {});
      const { installations } = await read<{ installations: Installation[] }>(listGitHubInstallations.id, {});
      const status = await read<InstallStatus>(getInstallStatus.id, {});
      const { banners } = await read<{ banners: Banner[] }>(getBanners.id, {});
      return htmlAnswer(
        htmlPage(
          "Admin",
          [
            "      <h1>Admin</h1>",
            adminNav(),
            ...bannersSection(banners, { csrf, back: ADMIN_PATH }),
            ...versionSection(options.version),
            ...backupsSection(status),
            ...githubSection(integration, installations),
            ...jiraSection(),
            ...emailSection(options.email),
          ].join("\n"),
        ),
      );
    },
  });
}
