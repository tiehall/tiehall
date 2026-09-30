import { z } from "zod";
import { defineCommand } from "./command.ts";

// The install's own state, which the admin page shows (self-host-install: The
// admin page warns about missing backups; design.md, Self-hosting decisions:
// S11): when the last backup finished, as backup.sh recorded it on the host,
// and whether the page warns because none has finished yet, or none in the
// last 7 days. Only the web UI reads it.

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

export const INSTALL_COMMANDS = [getInstallStatus];
