import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { documentedCommand, INSTALL_DOCS } from "@tiehall/repo-checks/docs-commands";

// The commands of the install docs, docs/install.md, as the operator tests run
// them (self-host-install: Backups with the shipped scripts;
// self-host-install: Upgrades apply migrations before the app starts): each
// test runs a documented command by its name, with the docs' example values
// replaced by its own, so the fresh-install, backup and upgrade jobs run what
// the docs say, and a change to a documented command is a change to what CI
// runs.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The install docs' command with this name, with each of the docs' example values replaced by the test's own. */
export function documented(id: string, values: Readonly<Record<string, string>> = {}): string {
  return documentedCommand(ROOT, id, values);
}

/** The folder the install docs' cron example runs backup.sh in. */
const CRON_FOLDER = "/srv/tiehall";

/**
 * The command of the install docs' cron example, the line that runs backup.sh
 * every day, such as `15 3 * * * cd /srv/tiehall && ./backup.sh ...`, with
 * the install's folder in place of the example's.
 */
export function documentedCronCommand(folder: string): string {
  const docs = readFileSync(join(ROOT, INSTALL_DOCS), "utf8").replace(/\s+/g, " ");
  const command = /`\d{1,2} \d{1,2} \* \* \* (cd \/srv\/tiehall && [^`]+)`/.exec(docs)?.[1];
  if (command === undefined) throw new Error(`${INSTALL_DOCS} holds no cron example that runs backup.sh in ${CRON_FOLDER}`);
  return command.split(CRON_FOLDER).join(folder);
}
