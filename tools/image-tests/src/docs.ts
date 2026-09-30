import { fileURLToPath } from "node:url";
import { documentedCommand } from "@tiehall/repo-checks/docs-commands";

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
