import { randomInt } from "node:crypto";
import type pg from "pg";

// The GitHub side of registered APIs for tests, written as the owner: an
// installation of the install's GitHub App on an account, connected or not,
// suspended or not, and the repositories it covers, as Tiehall last read them.
// A repository counts as covered while a connected installation that is
// neither suspended nor deleted holds it (tracker-mirrors: Covered
// repositories follow each connected installation).

export interface TestInstallation {
  /** The GitHub account the App is installed on, such as acme. */
  account: string;
  /** The account's numeric id on GitHub: a repository's owner id, as an OIDC token's repository_owner_id names it. */
  accountId?: number;
  /** The repositories it covers, by full name and GitHub's numeric id. */
  repositories: readonly { fullName: string; id: number }[];
  /** Whether an admin connected it; true unless given. */
  connected?: boolean;
  suspended?: boolean;
}

/** Adds an installation and the repositories it covers; returns Tiehall's id of it and the account's GitHub id. */
export async function addInstallation(owner: Pick<pg.ClientBase, "query">, installation: TestInstallation): Promise<{ id: string; accountId: number }> {
  const accountId = installation.accountId ?? randomInt(1, 2 ** 40);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO github_installations (org_id, app_id, installation_id, account_id, account_login, account_type, repository_selection, suspended_at)
     SELECT id, 4242, $1, $2, $3, 'Organization', 'selected', $4 FROM orgs RETURNING id`,
    [randomInt(1, 2 ** 40), accountId, installation.account, installation.suspended === true ? new Date() : null],
  );
  const id = rows[0]?.id ?? "";
  if (installation.connected !== false) {
    await owner.query("INSERT INTO github_connected_installations (org_id, installation_id) SELECT id, $1 FROM orgs", [id]);
    for (const repository of installation.repositories) {
      await owner.query(
        "INSERT INTO github_covered_repositories (org_id, installation_id, repository_id, full_name) SELECT id, $1, $2, $3 FROM orgs",
        [id, repository.id, repository.fullName],
      );
    }
  }
  return { id, accountId };
}
