import { getInstallStatus } from "@tiehall/catalog";
import type { z } from "zod";
import { escapeHtml, htmlPage } from "./html.ts";
import { ADMIN_PATH, adminNav } from "./admin-pages.ts";
import { createPageRoute, htmlAnswer, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The admin page at /admin, the first page of the admin UI (self-host-install:
// The admin page warns about missing backups; design.md, Self-hosting
// decisions: S11 and S12). It shows when the last backup finished, as
// backup.sh recorded it on the host, and warns when none has finished yet or
// none in the last 7 days, with what to do about it. It reads through
// execute(), as the signed-in user's web session, in a read-only transaction,
// and changes nothing; a browser without a session is sent to sign in first
// (D28 #66).

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

export function createAdminRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: ADMIN_PATH,
    name: "admin",
    async get(_query, { read }) {
      const status = await read<InstallStatus>(getInstallStatus.id, {});
      return htmlAnswer(htmlPage("Admin", ["      <h1>Admin</h1>", adminNav(), ...backupsSection(status)].join("\n")));
    },
  });
}
