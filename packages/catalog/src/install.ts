import { z } from "zod";
import { defineCommand } from "./command.ts";

// The install's own state, which the admin page shows (self-host-install: The
// admin page warns about missing backups; design.md, Self-hosting decisions:
// S11): when the last backup finished, as backup.sh recorded it on the host,
// and whether the page warns because none has finished yet, or none in the
// last 7 days; and the banners of the web UI about problems with the
// integrations (tracker-mirrors: Broken integrations are surfaced; design.md,
// Decisions this change rests on: D28 #41, #83). Only the web UI reads them.

/** How many days may pass after the last backup before the admin page warns. */
export const BACKUP_WARNING_DAYS = 7;

export const getInstallStatus = defineCommand({
  id: "install.get_status",
  summary: `The install's state for the admin page: when the last backup finished, and whether none has finished yet or none in the last ${BACKUP_WARNING_DAYS} days.`,
  input: z.object({}),
  output: z.object({
    /** The last backup backup.sh recorded as finished; null when none has. */
    lastBackup: z
      .object({
        finishedAt: z.iso.datetime(),
        file: z.string(),
        /** How many whole days before the call it finished. */
        daysAgo: z.int().min(0),
      })
      .nullable(),
    /** no_backup when none has finished, stale when the last finished more than 7 days ago, and null otherwise. */
    backupWarning: z.enum(["no_backup", "stale"]).nullable(),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

/** A banner of the web UI: a problem with an integration, in Tiehall's own words, and where to fix it. */
export const banner = z.object({
  /** What the banner is about, such as github_webhook. */
  id: z.string(),
  text: z.string(),
  /** The page that says more, on the install. */
  link: z.object({ href: z.string(), text: z.string() }),
});

export const getBanners = defineCommand({
  id: "install.get_banners",
  summary:
    "The banners the web UI shows you: the problems with the install's integrations that you may act on. Admins see every one; a team's members see those of the integrations their team's mirrors go through.",
  input: z.object({}),
  output: z.object({ banners: z.array(banner) }),
  scopes: [],
  commitment: false,
  confirm: false,
  surfaces: [],
  stability: "alpha",
});

export const INSTALL_COMMANDS = [getInstallStatus, getBanners];
