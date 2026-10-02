import { readEmailSettings, setEmailSettings, setRequesterEmails, type emailSettings } from "@tiehall/catalog";
import { Refusal } from "@tiehall/core";
import { members, teamMembers, teamRequesterEmails, users } from "@tiehall/db";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { defineHandler, type Handlers } from "./execute.ts";
import { teamsOfMember } from "./members.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// A user's email settings (requester-loop: Email for people, only when SMTP is
// set; design.md, Decisions this change rests on: D28 #61; D29 (6); design.md,
// Self-hosting decisions: S10). The signed-in user reads where Tiehall emails
// them, the primary verified address of their GitHub account, which sign-in
// read, and turns their daily digest on or off; nothing else can be set, so
// transactional email, such as proposal notices, receipts and the questions
// asked of them, always goes out when the install sends email. The member
// also turns on or off, for each of their own teams, the emails that go to
// that team as the requester of a request, which are off until they turn them
// on (requester-loop: When the requester is a team); a team that is not
// theirs gets 403. The choice lasts while they are in the team: leaving it, or
// the install, deletes it (the foreign key to the team membership cascades),
// so a member added to the team again starts with it off. The settings are the
// user's own, change no request and so record no event, and need no
// confirmation step.

type EmailSettings = z.input<typeof emailSettings>;

async function settingsOf(context: OrgContext, userId: string): Promise<EmailSettings> {
  const { tx, orgId } = context;
  const [row] = await tx
    .select({ address: users.email, digest: users.digestEnabled })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.id, userId)));
  if (row === undefined) throw new Error("A signed-in member has no user.");
  const optedIn = await tx
    .select({ teamId: teamRequesterEmails.teamId })
    .from(teamRequesterEmails)
    .where(and(eq(teamRequesterEmails.orgId, orgId), eq(teamRequesterEmails.userId, userId)));
  const mine = await teamsOfMember(context, userId);
  return {
    ...row,
    teams: [...mine]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ id, key }) => ({ team: { id, key }, requesterEmails: optedIn.some(({ teamId }) => teamId === id) })),
  };
}

/**
 * The members of a requesting team who get its emails as a requester: those
 * who opted in to that team's emails, while they are members of the install
 * and of the team (requester-loop: When the requester is a team).
 */
export async function optedInMembersOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, teamId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: teamRequesterEmails.userId })
    .from(teamRequesterEmails)
    .innerJoin(teamMembers, and(eq(teamMembers.orgId, teamRequesterEmails.orgId), eq(teamMembers.teamId, teamRequesterEmails.teamId), eq(teamMembers.userId, teamRequesterEmails.userId)))
    .innerJoin(members, and(eq(members.orgId, teamRequesterEmails.orgId), eq(members.userId, teamRequesterEmails.userId)))
    .where(and(eq(teamRequesterEmails.orgId, orgId), eq(teamRequesterEmails.teamId, teamId)))
    .orderBy(asc(teamRequesterEmails.userId));
  return rows.map(({ userId }) => userId);
}

export const EMAIL_SETTINGS_HANDLERS: Handlers = {
  [readEmailSettings.id]: defineHandler(readEmailSettings, async (_input, context) => settingsOf(context, actingUserOf(context))),

  [setEmailSettings.id]: defineHandler(setEmailSettings, async ({ digest }, context) => {
    const userId = actingUserOf(context);
    await context.tx
      .update(users)
      .set({ digestEnabled: digest })
      .where(and(eq(users.orgId, context.orgId), eq(users.id, userId)));
    return settingsOf(context, userId);
  }),

  [setRequesterEmails.id]: defineHandler(setRequesterEmails, async ({ team, on }, context) => {
    const userId = actingUserOf(context);
    if (!(await teamsOfMember(context, userId)).some(({ id }) => id === team)) {
      throw new Refusal("forbidden", "You choose the emails of your own teams only.");
    }
    if (on) {
      await context.tx.insert(teamRequesterEmails).values({ orgId: context.orgId, userId, teamId: team, optedInAt: context.now() }).onConflictDoNothing();
    } else {
      await context.tx
        .delete(teamRequesterEmails)
        .where(and(eq(teamRequesterEmails.orgId, context.orgId), eq(teamRequesterEmails.userId, userId), eq(teamRequesterEmails.teamId, team)));
    }
    return settingsOf(context, userId);
  }),
};
