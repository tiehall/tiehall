import { createInvite, findInviteAccount, listInvites, revokeInvite } from "@tiehall/catalog";
import { inviteCreated, inviteRevoked, Refusal, type ReviewLine, type Role } from "@tiehall/core";
import { githubApp, invites, members } from "@tiehall/db";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { definePreparedReview, type ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, definePreparedHandler, type Handlers } from "./execute.ts";
import { GitHubUnavailableError } from "./github-client.ts";
import { anyConnectedInstallation, type GitHubAppAccess } from "./github-installations.ts";
import { gitHubAccountNamed, gitHubAccountWithId, userOfGitHubAccount, type GitHubAccountProfile } from "./github-users.ts";
import type { InstallGitHub } from "./install-github.ts";
import type { OrgContext } from "./with-org.ts";

// Invites (teams-and-roles: Invites by GitHub username; sign-in: Who may sign
// in; activity-log: Which actions are security events; agent-safety: Actions
// that need the confirmation step; design.md, Self-hosting decisions: S5).
// An admin invites a person by their GitHub username, in the web UI, with the
// confirmation step. The invite form looks the username up at once, before
// any review page (github-layer-hardening: design.md, Decisions this change
// rests on: D50 (12); Technical decisions: T6): invites.find_account, an
// admin's internal read, asks GitHub which account the username names, with
// an installation token of a connected installation of the install's App,
// and with none the form gets 409. A username that names no person's GitHub
// account gets 404 there, and an account whose person is already a member
// 409, since the invite would admit nobody; each creates nothing. Otherwise
// the admin goes on to the review page of invites.create, whose input names
// the account's numeric id and the role, so the confirmation binds the invite
// to the account the admin saw. The review page reads the account by that id
// and names it in Tiehall's own words by its login, its numeric id and the
// date GitHub created it, and quotes the display name GitHub gives as text
// from outside Tiehall, because anyone can set it. The confirmation reads the
// account by its id again, for its login now. Every read of GitHub runs
// outside any transaction: the look-up and the confirmation's read before
// their calls' transactions (execute.ts), the confirmation's before its nonce
// is used, and the review page's before the review's transaction
// (confirmation-step.ts); the write reads again what the read rested on: an
// App replaced meanwhile, or a person who became a member, gets 409. GitHub
// failing a read, or not answering it within the client's 10 seconds, gets
// 502 integration-unavailable, which leaves the confirmation unused, so the
// admin can confirm the same review page again (public-api: One error model
// for Tiehall's own refusals). The invite follows a rename of the login and
// never passes to a new holder of the old one. The invite names a role,
// `member` unless it names `admin`, and expires 7 days after it is created. It
// needs no email: the invitee accepts it by signing in with that account while
// it is valid (sign-in-admission.ts). The invite and its security event commit
// together.
//
// One pending invite per account (github-layer-hardening: design.md,
// Decisions this change rests on: D50 (11); Technical decisions: T6): a new
// invite for an account that has a
// pending invite, one neither accepted, revoked nor expired, replaces it. The
// older invite is revoked, with its own invite.revoked event, in the write
// that creates the new one and records invite.created, so the invites page
// never lists two invites for one person and the sign-in never has to choose
// between two roles; the review page names the invite it replaces, with its
// role and when it expires. An invite that is accepted, revoked or expired is
// left as it is. The write holds a lock on the account from its start, so two
// admins inviting the same person at once leave one pending invite: the
// second write waits, then replaces the first one's invite.
//
// Revoking an invite (teams-and-roles: Revoking an invite): an admin revokes
// a pending invite in the web UI, without the confirmation step, because it
// only narrows who may join; the web UI's write checks still apply. A revoked
// invite admits no one. Revoking one again changes nothing more, and an
// invite that a sign-in accepted can no longer be revoked (409): its person is
// a member, whom only a removal ends. The revocation and its security event
// commit together.
//
// The invites that wait (teams-and-roles: What admins and members may do):
// an admin reads, on the web UI's invites page, every invite that is neither
// accepted, revoked nor expired, oldest first, with the role it gives and when
// it expires, so they can revoke one. It is an admin action, like creating
// and revoking invites, and reads only.

/** How long an invite stays valid after it is created. */
export const INVITE_LIFETIME_DAYS = 7;

/**
 * Locks, until the transaction ends, the creation of invites for this GitHub
 * account, by its numeric id: a lock on the account rather than on a row,
 * because no row exists yet when neither admin's invite does. The write takes
 * it before any other lock and before its first event, as the lock order has
 * it (event-sequence.ts), and no other write takes it.
 */
async function lockInvitesOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, githubAccountId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId} invite account ${githubAccountId}`}, 0))`);
}

/** How the invite's steps before their transactions reach GitHub and read the install. */
interface GitHubReach {
  readonly github: InstallGitHub | undefined;
  read<T>(read: (context: OrgContext) => Promise<T>): Promise<T>;
}

/** The install's App and a connected installation of it to ask GitHub through; 409 without either. */
async function connectedInstallation(context: GitHubReach): Promise<{ app: GitHubAppAccess; installationId: number }> {
  const app = await context.github?.app();
  if (app === undefined) throw new Refusal("conflict", "The install has no GitHub App to look the account up through.");
  const installationId = await context.read((orgContext) => anyConnectedInstallation(orgContext, app.appId));
  if (installationId === undefined) {
    throw new Refusal(
      "conflict",
      "The install's GitHub App has no connected installation to look the account up through. Install it on your GitHub organization and connect that installation first.",
    );
  }
  return { app, installationId };
}

/** GitHub failing a call an invite needs, as the error model's refusal, which changes nothing. */
function unavailable(error: GitHubUnavailableError, what: string): Refusal {
  return new Refusal("integration-unavailable", `${error.message} ${what}`);
}

/**
 * The person's GitHub account with this numeric id, as GitHub gives it now,
 * read outside any transaction through a connected installation: 404 when
 * GitHub knows no such account or it is an organization's, 502 when GitHub
 * fails the read or does not answer it.
 */
async function inviteAccountWithId(context: GitHubReach, accountId: number, what: string): Promise<{ appId: number; account: GitHubAccountProfile }> {
  const { app, installationId } = await connectedInstallation(context);
  let account;
  try {
    account = await gitHubAccountWithId(app.client, installationId, accountId);
  } catch (error) {
    if (!(error instanceof GitHubUnavailableError)) throw error;
    throw unavailable(error, what);
  }
  if (account?.type !== "User") throw new Refusal("record-not-found", "GitHub knows no person's account with that id.");
  return { appId: app.appId, account };
}

/** Refuses, with 409, an invite for an account whose person is a member of the install, as this transaction reads it. */
async function assertNotMember(context: Pick<OrgContext, "tx" | "orgId">, accountId: number): Promise<void> {
  const userId = await userOfGitHubAccount(context, { id: accountId });
  if (userId === undefined) return;
  const [member] = await context.tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.orgId, context.orgId), eq(members.userId, userId)));
  if (member !== undefined) throw new Refusal("conflict", "That GitHub account's person is already a member of the install.");
}

/** The account's invite that waits to be accepted: neither accepted, revoked nor expired; at most one. */
async function pendingInviteOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, accountId: number) {
  const [pending] = await tx
    .select({ id: invites.id, githubLogin: invites.githubLogin, role: invites.role, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(eq(invites.orgId, orgId), eq(invites.githubAccountId, accountId), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
    .orderBy(desc(invites.createdAt), desc(invites.id))
    .limit(1);
  return pending;
}

export const INVITE_HANDLERS: Handlers = {
  // The invite form's look-up: GitHub is asked outside any transaction, and the membership read in the call's.
  [findInviteAccount.id]: definePreparedHandler(
    findInviteAccount,
    async ({ login }, context) => {
      const { installationId, app } = await connectedInstallation(context);
      let account;
      try {
        account = await gitHubAccountNamed(app.client, installationId, login);
      } catch (error) {
        if (!(error instanceof GitHubUnavailableError)) throw error;
        throw unavailable(error, "No invite was created; submit the invite form again once GitHub answers.");
      }
      if (account?.type !== "User") throw new Refusal("record-not-found", "That GitHub username names no person's GitHub account.");
      return account;
    },
    async (_input, context) => {
      const account = context.prepared;
      await assertNotMember(context, account.id);
      return { account: { id: account.id, githubLogin: account.login } };
    },
  ),

  [createInvite.id]: definePreparedHandler(
    createInvite,
    // GitHub is asked outside any transaction, before the invite's write and the use of its confirmation.
    ({ accountId }, context) =>
      inviteAccountWithId(
        context,
        accountId,
        "No invite was created, and your confirmation is still unused: confirm the same review page again, while it is valid, once GitHub answers.",
      ),
    async ({ role }, context) => {
      const { appId, account } = context.prepared;
      // Invites for one account are created one at a time, so two admins inviting the same person at once cannot
      // both find no pending invite: the second waits here, then replaces the first one's.
      await lockInvitesOf(context, account.id);
      // What the read rested on, read again now: the App it went through, and whether the person is a member.
      const [app] = await context.tx.select({ appId: githubApp.appId }).from(githubApp).where(eq(githubApp.orgId, context.orgId));
      if (app?.appId !== appId) {
        throw new Refusal("conflict", "The install's GitHub App changed while GitHub named the account, so no invite was created. Confirm the invite again.");
      }
      await assertNotMember(context, account.id);
      return context.write(async (writer) => {
        // The account's pending invite, if any, is revoked in the write that creates the new one.
        const replaced = await writer.tx
          .update(invites)
          .set({ revokedAt: sql`now()`, revokedBy: context.member!.userId })
          .where(
            and(
              eq(invites.orgId, writer.orgId),
              eq(invites.githubAccountId, account.id),
              isNull(invites.acceptedAt),
              isNull(invites.revokedAt),
              gt(invites.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: invites.id });
        for (const { id } of replaced) await writer.record(inviteRevoked, { inviteId: id });
        const [created] = await writer.tx
          .insert(invites)
          .values({
            orgId: writer.orgId,
            githubAccountId: account.id,
            githubLogin: account.login,
            role,
            createdBy: context.member!.userId,
            expiresAt: sql`now() + make_interval(days => ${INVITE_LIFETIME_DAYS})`,
          })
          .returning({ id: invites.id, expiresAt: invites.expiresAt });
        await writer.record(inviteCreated, { inviteId: created!.id, role });
        return { invite: { id: created!.id, githubLogin: account.login, role, expiresAt: created!.expiresAt.toISOString() } };
      });
    },
  ),

  [listInvites.id]: defineHandler(listInvites, async (_input, { tx, orgId }) => {
    const rows = await tx
      .select({ id: invites.id, githubLogin: invites.githubLogin, role: invites.role, expiresAt: invites.expiresAt })
      .from(invites)
      .where(and(eq(invites.orgId, orgId), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
      .orderBy(asc(invites.createdAt), asc(invites.id));
    return { invites: rows.map(({ id, githubLogin, role, expiresAt }) => ({ id, githubLogin, role: role as Role, expiresAt: expiresAt.toISOString() })) };
  }),

  [revokeInvite.id]: defineHandler(revokeInvite, async ({ invite }, context) => {
    const [row] = await context.tx
      .select({ acceptedAt: invites.acceptedAt, revokedAt: invites.revokedAt })
      .from(invites)
      .where(and(eq(invites.orgId, context.orgId), eq(invites.id, invite)))
      .for("update");
    if (row === undefined) throw new Refusal("record-not-found", "The install has no such invite.");
    if (row.revokedAt !== null) return { invite, revoked: true as const };
    if (row.acceptedAt !== null) throw new Refusal("conflict", "A sign-in accepted that invite already, so it cannot be revoked; remove the member instead.");
    return context.write(async (writer) => {
      await writer.tx
        .update(invites)
        .set({ revokedAt: sql`now()`, revokedBy: context.member!.userId })
        .where(and(eq(invites.orgId, writer.orgId), eq(invites.id, invite)));
      await writer.record(inviteRevoked, { inviteId: invite });
      return { invite, revoked: true as const };
    });
  }),
};

/** The review pages of invites, in Tiehall's own words, with the display name GitHub gives quoted as data from outside Tiehall. */
export const INVITE_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [createInvite.id]: definePreparedReview(
    // The account is read by its id outside any transaction, before the review's.
    (input, context) =>
      inviteAccountWithId(context, (input as { accountId: number }).accountId, "Nothing was created; open the review page again once GitHub answers."),
    async (input, context) => {
      const { role } = input as { accountId: number; role: Role };
      const { account } = context.prepared;
      const replaces = await pendingInviteOf(context, account.id);
      const lines: ReviewLine[] = [
        { text: `Invite the GitHub account ${account.login} to the install, with the role ${role}.` },
        { text: `The account's numeric id on GitHub is ${account.id}.` },
        { text: account.createdAt === undefined ? "GitHub gives no date on which it created the account." : `GitHub created the account on ${account.createdAt.slice(0, 10)}.` },
        ...(account.displayName === null
          ? [{ text: "The account has no display name on GitHub." }]
          : [
              { text: "The display name the account's owner set on GitHub, which anyone can set to anything:" },
              { quote: account.displayName, origin: "external" as const },
            ]),
        ...(replaces === undefined
          ? []
          : [
              {
                text:
                  `It replaces the pending invite for ${replaces.githubLogin}, with the role ${replaces.role}, which expires ${replaces.expiresAt.toISOString()}: ` +
                  "confirming this invite revokes that one.",
              },
            ]),
        {
          text:
            "When you confirm, the invite is bound to this account by its numeric id: " +
            "it stays with the account if its login is renamed, and never passes to someone who later takes the login.",
        },
        {
          text: `They join by signing in with that GitHub account while the invite is valid. The invite expires ${INVITE_LIFETIME_DAYS} days after it is created, and no email is sent.`,
        },
        {
          text:
            role === "admin"
              ? "As an admin, they can invite and remove members, change roles, manage teams, integrations and settings, and read the activity log."
              : "As a member, they join in no team and take no admin action.",
        },
      ];
      return { title: "Invite a person", lines };
    },
  ),
};
