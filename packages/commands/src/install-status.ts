import { BACKUP_WARNING_DAYS, getInstallStatus } from "@tiehall/catalog";
import { backups } from "@tiehall/db";
import { desc, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";

// The install's own state for the admin page (self-host-install: The admin
// page warns about missing backups; design.md, Self-hosting decisions: S11).
// backup.sh records each backup that finished, on the host, as the database
// owner; this read finds the latest, and says whether the admin page warns
// because none has finished yet, or none within the last 7 days by the call's
// clock.

const DAY_MS = 24 * 60 * 60 * 1000;

export const INSTALL_STATUS_HANDLERS: Handlers = {
  [getInstallStatus.id]: defineHandler(getInstallStatus, async (_input, context) => {
    const [last] = await context.tx
      .select({ finishedAt: backups.finishedAt, file: backups.file })
      .from(backups)
      .where(eq(backups.orgId, context.orgId))
      .orderBy(desc(backups.finishedAt))
      .limit(1);
    if (last === undefined) return { lastBackup: null, backupWarning: "no_backup" as const };
    const age = Math.max(0, context.now().getTime() - last.finishedAt.getTime());
    return {
      lastBackup: { finishedAt: last.finishedAt.toISOString(), file: last.file, daysAgo: Math.floor(age / DAY_MS) },
      backupWarning: age > BACKUP_WARNING_DAYS * DAY_MS ? ("stale" as const) : null,
    };
  }),
};
