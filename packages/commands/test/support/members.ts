import { randomInt, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Role } from "@tiehall/core";

// People of the install for tests, written as the owner: a user, identified by
// a GitHub account, and, unless the test says otherwise, their membership with
// a role. The install's org must exist.

export interface TestUser {
  /** The user's Tiehall id; a new one unless given. */
  userId?: string;
  /** The GitHub login the user is shown by. */
  login?: string;
  /** The member's role; null makes a user who is not a member, such as one who was removed. */
  role?: Role | null;
  /** The GitHub account's numeric id; a random one unless given, such as the id of the GitHub stub's account. */
  githubAccountId?: number;
}

/**
 * Adds a user and, unless role is null, makes them a member with that role
 * (member by default); returns their id. The user has signed in with their
 * GitHub account before, as every user has: the sign-in service knows the
 * account as theirs.
 */
export async function addUser(owner: Pick<pg.ClientBase, "query">, user: TestUser = {}): Promise<string> {
  const userId = user.userId ?? randomUUID();
  const login = user.login ?? `user-${userId.slice(0, 8)}`;
  const githubAccountId = user.githubAccountId ?? randomInt(1, 2 ** 47);
  await owner.query(
    `INSERT INTO users (org_id, id, github_account_id, github_login, sign_in_key) SELECT id, $1, $2, $3, $4 FROM orgs`,
    [userId, githubAccountId, login, `github:${githubAccountId}`],
  );
  await owner.query(
    `INSERT INTO sign_in_accounts (org_id, id, user_id, provider_id, account_id) SELECT id, gen_random_uuid(), $1, 'github', $2 FROM orgs`,
    [userId, String(githubAccountId)],
  );
  const role = user.role === undefined ? "member" : user.role;
  if (role !== null) await owner.query("INSERT INTO members (org_id, user_id, role) SELECT id, $1, $2 FROM orgs", [userId, role]);
  return userId;
}
