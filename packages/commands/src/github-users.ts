import { and, eq } from "drizzle-orm";
import { users } from "@tiehall/db";
import type { OrgContext } from "./with-org.ts";

// GitHub users as Tiehall users (sign-in: One Tiehall user per GitHub account;
// design.md, Self-hosting decisions: S5). Tiehall knows a person by their
// GitHub account's numeric id, which never changes, never by the login, which
// a rename changes and a new account can take, or by an email address. So a
// GitHub user that GitHub names, such as the author of a pull request, is the
// Tiehall user whose GitHub account has that id, if there is one, whatever
// login GitHub shows.

/** The Tiehall user of the GitHub account with this numeric id, as GitHub's API gives it, or undefined when no user has it. */
export async function userOfGitHubAccount({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, account: { id: number | bigint }): Promise<string | undefined> {
  const id = Number(account.id);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.githubAccountId, id)));
  return row?.id;
}
