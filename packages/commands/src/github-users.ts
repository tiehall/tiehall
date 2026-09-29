import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@tiehall/db";
import type { GitHubClient } from "./github-client.ts";
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

/** A GitHub account as GitHub's API names it: its numeric id, its login now, and whether it is a person's or an organization's. */
export interface GitHubAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
}

const ACCOUNT = z.object({ id: z.number().int().positive(), login: z.string().min(1), type: z.string() });

/**
 * The GitHub account a login names now, as GitHub's API gives it to one of
 * the App's installations, with that installation's token (teams-and-roles:
 * Invites by GitHub username); undefined when GitHub knows no account by
 * that login, or one of a kind that is neither a person's nor an
 * organization's. It throws when GitHub does not answer, within the client's
 * timeout (github-client.ts).
 */
export async function gitHubAccountNamed(client: GitHubClient, installationId: number, login: string): Promise<GitHubAccount | undefined> {
  let data: unknown;
  try {
    ({ data } = await client.installation(installationId).request("GET /users/{username}", { username: login }));
  } catch (error) {
    if ((error as { status?: unknown } | undefined)?.status === 404) return undefined;
    throw error;
  }
  const account = ACCOUNT.safeParse(data);
  if (!account.success || (account.data.type !== "User" && account.data.type !== "Organization")) return undefined;
  return { id: account.data.id, login: account.data.login, type: account.data.type };
}

/**
 * The GitHub account with this numeric id as GitHub's API gives it now to one
 * of the App's installations, with that installation's token, by
 * `GET /user/{account_id}`: its login now, whatever login an older report
 * named it by; undefined when GitHub knows no account with that id, or one of
 * a kind that is neither a person's nor an organization's. It throws when
 * GitHub does not answer, within the client's timeout (github-client.ts).
 */
export async function gitHubAccountWithId(client: GitHubClient, installationId: number, id: number): Promise<GitHubAccount | undefined> {
  let data: unknown;
  try {
    ({ data } = await client.installation(installationId).request("GET /user/{account_id}", { account_id: id }));
  } catch (error) {
    if ((error as { status?: unknown } | undefined)?.status === 404) return undefined;
    throw error;
  }
  const account = ACCOUNT.safeParse(data);
  if (!account.success || account.data.id !== id || (account.data.type !== "User" && account.data.type !== "Organization")) return undefined;
  return { id: account.data.id, login: account.data.login, type: account.data.type };
}
