import { getBanners, getGitHubIntegration, getInstallStatus, getWriteBudget, listGitHubInstallations, setWriteBudget, type githubInstallation } from "@tiehall/catalog";
import type { z } from "zod";
import type { Banner } from "./admin-alerts.ts";
import type { DocsLink } from "./docs-pages.ts";
import type { EmailStatus } from "./email.ts";
import { GITHUB_ADMIN_PATH } from "./github-admin-route.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { ACTIVITY_LOG_PATH } from "./activity-log-route.ts";
import { ADMIN_PATH, adminNav, APIS_PATH, INVITES_PATH, MEMBERS_PATH, PERSONAL_ACCESS_TOKEN_SETTINGS_PATH, reviewPath, SIGN_IN_POLICY_PATH, TEAMS_PATH } from "./admin-pages.ts";
import { fieldHtml } from "./page-parts.ts";
import type { RunningVersion } from "./running-version.ts";
import { createPageRoute, htmlAnswer, link, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

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
// problems with the integrations (admin-alerts.ts). It shows the install's
// daily budget of agent writes, with a form that leads to the review page of
// the budget it names, where the change takes the confirmation step
// (agent-safety: Agent writes are limited per token and budgeted per
// install). Last, it links each page of the user and admin docs, at the
// running version's docs (task 28.6; docs-pages.ts). Each area is a card of a
// grid, which links the area's page or holds its state and its form
// (web-ui: The page shell and its navigation; design.md, Design: The page
// families; D57 (4)). The integrations are an
// admin's to read, so the page is an admin's: a member gets 403 and no state,
// and their form changes nothing.

export interface AdminRouteOptions extends PageRouteOptions {
  /** The running version and the link to its source; the page shows no version without it. */
  version?: RunningVersion;
  /** Whether email is set up, from the install's SMTP settings, never its login; the page says nothing of email without it. */
  email?: EmailStatus;
  /** The docs pages, linked at the running version's docs; the page lists no docs without them. */
  docs?: readonly DocsLink[];
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
    lines.push(`      <p class="notice"><strong>${escapeHtml("No backup has finished yet.")}</strong> ${escapeHtml(BACKUP_ADVICE)}</p>`);
    return lines;
  }
  lines.push(`      <p>${escapeHtml(`The last backup finished at ${utcTime(lastBackup.finishedAt)}, ${daysAgoText(lastBackup.daysAgo)}: ${lastBackup.file}.`)}</p>`);
  if (backupWarning === "stale") {
    lines.push(`      <p class="notice"><strong>${escapeHtml("No backup has finished in the last 7 days.")}</strong> ${escapeHtml(BACKUP_ADVICE)}</p>`);
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
 * The banners, first on the page, each in the notice colors with the page
 * that says more, and its button, such as Retry for a failed mirror job: a
 * form that posts the button's fields to its path on the install, with the
 * session's CSRF token and the page to lead back to (web-ui: Pages are
 * accessible; design.md, Design: The page families; D57 (1)).
 */
export function bannersSection(banners: readonly Banner[], form: { csrf: string; back: string }): string[] {
  if (banners.length === 0) return [];
  return [
    '      <section class="banners" aria-label="Alerts">',
    ...banners.flatMap((banner) => [
      '        <div class="notice banner">',
      `          <p><strong>${escapeHtml(banner.text)}</strong> ${link(banner.link.href, banner.link.text)}</p>`,
      ...(banner.button === undefined ? [] : bannerForm(banner.button, form)),
      "        </div>",
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

/** A card of an area whose page holds its settings: what it is, and the links to its pages. */
function areaCard(title: string, text: string, links: readonly [href: string, text: string][]): string[] {
  return [
    `      <h2>${escapeHtml(title)}</h2>`,
    `      <p>${escapeHtml(text)}</p>`,
    `      <p class="card-actions">${links.map(([href, label]) => `<a class="button secondary" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join(" ")}</p>`,
  ];
}

/**
 * Each part of the overview as a card in a grid, from its heading to the next
 * (design.md, Design: The page families; D57 (1), (4)).
 */
function asCards(parts: readonly (readonly string[])[]): string[] {
  return [
    '      <ul class="cards admin-cards">',
    ...parts.filter((part) => part.length > 0).flatMap((part) => ['      <li class="card">', ...part, "      </li>"]),
    "      </ul>",
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
  const open = `      <p class="card-actions"><a class="button secondary" href="${GITHUB_ADMIN_PATH}">Open the GitHub page</a></p>`;
  if (integration.app === null) return [...lines, "      <p>The install has no GitHub App yet.</p>", open];
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
  lines.push(open);
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

/** The budget section: the install's daily budget of agent writes, and a form that leads to the review page of another. */
function writeBudgetSection(dailyWriteBudget: number, csrf: string): string[] {
  return [
    "      <h2>Agent writes</h2>",
    `      <p>${escapeHtml(`The install's agents may make ${dailyWriteBudget.toLocaleString("en-US")} writes per UTC day, together. A write beyond the budget is refused until the next UTC day begins.`)}</p>`,
    `      <form method="post" action="${ADMIN_PATH}">`,
    fieldHtml("daily-write-budget", "The daily budget of agent writes, from 1 to 1,000,000", `<input type="number" id="daily-write-budget" name="dailyWriteBudget" min="1" max="1000000" value="${dailyWriteBudget}" required>`),
    `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    '        <button type="submit" class="secondary">Review the change</button>',
    "      </form>",
  ];
}

/** A whole number a form gives, or the text as it was typed, which the review page refuses. */
function numberOf(value: string | null): number | string {
  const text = (value ?? "").trim();
  return /^\d{1,7}$/.test(text) ? Number(text) : text;
}

/** The documentation section: a link to each page of the user and admin docs. */
function docsSection(docs: readonly DocsLink[] | undefined): string[] {
  if (docs === undefined || docs.length === 0) return [];
  return [
    "      <h2>Documentation</h2>",
    `      <p>${escapeHtml("The docs of the running version: how people and their agents use Tiehall, and how admins run it.")}</p>`,
    '      <ul class="link-list">',
    ...docs.map(({ title, url }) => `        <li>${link(url, title)}</li>`),
    "      </ul>",
  ];
}

export function createAdminRoute(options: AdminRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: ADMIN_PATH,
    name: "admin",
    async get(_query, { read, csrf, shell }) {
      // The integrations are an admin's: a member's read of them is refused with 403, and the page shows nothing.
      const integration = await read<Integration>(getGitHubIntegration.id, {});
      const { installations } = await read<{ installations: Installation[] }>(listGitHubInstallations.id, {});
      const status = await read<InstallStatus>(getInstallStatus.id, {});
      const { banners } = await read<{ banners: Banner[] }>(getBanners.id, {});
      const { dailyWriteBudget } = await read<{ dailyWriteBudget: number }>(getWriteBudget.id, {});
      return htmlAnswer(
        htmlPage(
          "Admin",
          [
            "      <h1>Admin</h1>",
            adminNav(ADMIN_PATH),
            ...bannersSection(banners, { csrf, back: ADMIN_PATH }),
            ...asCards([
              areaCard("People and invites", "Who belongs to the install, with their roles, and the invites that wait to be accepted.", [
                [MEMBERS_PATH, "Members"],
                [INVITES_PATH, "Invites"],
              ]),
              areaCard("Teams", "The teams requests are addressed to, their people, how each wants requests filed, and where their requests are mirrored.", [[TEAMS_PATH, "Teams"]]),
              areaCard("Sign-in policy", "Who may sign in and join: members of the connected GitHub organizations and invited people, or invited people only.", [[SIGN_IN_POLICY_PATH, "Sign-in policy"]]),
              githubSection(integration, installations),
              jiraSection(),
              areaCard("Personal access tokens", "Whether personal access tokens work in this install, and how long a new one lives at most.", [[PERSONAL_ACCESS_TOKEN_SETTINGS_PATH, "Personal access tokens"]]),
              writeBudgetSection(dailyWriteBudget, csrf),
              areaCard("APIs", "The APIs that receive contract reports, their provider teams and their WARN switches.", [[APIS_PATH, "APIs"]]),
              areaCard("Activity log", "Every change to a request and every security-relevant action, newest first, with the export.", [[ACTIVITY_LOG_PATH, "Activity log"]]),
              backupsSection(status),
              versionSection(options.version),
              emailSection(options.email),
              docsSection(options.docs),
            ]),
          ].join("\n"),
          shell,
        ),
      );
    },
    async post(form, { read }) {
      // Only an admin's form leads on: a member gets 403, as for the page.
      await read(getWriteBudget.id, {});
      return seeOther(reviewPath(setWriteBudget.id, { dailyWriteBudget: numberOf(form.get("dailyWriteBudget")) }));
    },
  });
}
