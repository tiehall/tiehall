import { createInvite, revokeInvite } from "@tiehall/catalog";
import { inviteCreated, inviteRevoked, Refusal, type Role } from "@tiehall/core";
import { invites, members } from "@tiehall/db";
import { and, eq, sql } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import { anyLiveInstallation } from "./github-installations.ts";
import { gitHubAccountNamed, userOfGitHubAccount } from "./github-users.ts";

// Invites (teams-and-roles: Invites by GitHub username; sign-in: Who may sign
// in; activity-log: Which actions are security events; agent-safety: Actions
// that need the confirmation step; design.md, Self-hosting decisions: S5).
// An admin invites a person by their GitHub username, in the web UI, with the
// confirmation step. When the invite is created, Tiehall asks GitHub which
// account the username names, with an installation token of the install's
// App, and binds the invite to that account's numeric id: the invite follows
// a rename of the login and never passes to a new holder of the old one. A
// username that names no person's GitHub account gets 404 and creates no
// invite. The invite names a role, `member` unless it names `admin`, and
// expires 7 days after it is created. It needs no email: the invitee accepts
// it by signing in with that account while it is valid (sign-in-admission.ts).
// An invite for a person who is already a member would admit nobody, so it is
// refused with 409. The invite and its security event commit together.
//
// Revoking an invite (teams-and-roles: Revoking an invite): an admin revokes
// a pending invite in the web UI, without the confirmation step, because it
// only narrows who may join; the web UI's write checks still apply. A revoked
// invite admits no one. Revoking one again changes nothing more, and an
// invite that a sign-in accepted can no longer be revoked (409): its person is
// a member, whom only a removal ends. The revocation and its security event
// commit together.

/** How long an invite stays valid after it is created. */
export const INVITE_LIFETIME_DAYS = 7;

export const INVITE_HANDLERS: Handlers = {
  [createInvite.id]: defineHandler(createInvite, async ({ login, role }, context) => {
    const app = await context.github?.app();
    if (app === undefined) throw new Refusal("conflict", "The install has no GitHub App to look the username up through.");
    const installationId = await anyLiveInstallation(context, app.appId);
    if (installationId === undefined) {
      throw new Refusal("conflict", "The install's GitHub App has no installation to look the username up through. Install it on your GitHub organization first.");
    }
    const account = await gitHubAccountNamed(app.client, installationId, login);
    if (account?.type !== "User") throw new Refusal("record-not-found", "That GitHub username names no person's GitHub account.");
    const userId = await userOfGitHubAccount(context, { id: account.id });
    if (userId !== undefined) {
      const [member] = await context.tx
        .select({ userId: members.userId })
        .from(members)
        .where(and(eq(members.orgId, context.orgId), eq(members.userId, userId)));
      if (member !== undefined) throw new Refusal("conflict", "That GitHub account's person is already a member of the install.");
    }
    return context.write(async (writer) => {
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

/** The review pages of invites, in Tiehall's own words. */
export const INVITE_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [createInvite.id]: async (input) => {
    const { login, role } = input as { login: string; role: Role };
    return {
      title: "Invite a person",
      lines: [
        { text: `Invite the GitHub account ${login} to the install, with the role ${role}.` },
        {
          text:
            "When you confirm, Tiehall asks GitHub which account the username names and binds the invite to that account: " +
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
      ],
    };
  },
};
