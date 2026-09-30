import { readEmailSettings, setEmailSettings } from "@tiehall/catalog";
import { users } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { actingUserOf } from "./request-changes.ts";
import type { OrgContext } from "./with-org.ts";

// A user's email settings (requester-loop: Email for people, only when SMTP is
// set; design.md, Decisions this change rests on: D28 #61; D29 (6); design.md,
// Self-hosting decisions: S10). The signed-in user reads where Tiehall emails
// them, the primary verified address of their GitHub account, which sign-in
// read, and turns their daily digest on or off; nothing else can be set, so
// transactional email, such as proposal notices, receipts and the questions
// asked of them, always goes out when the install sends email. The setting is
// the user's own, changes no request and so records no event, and needs no
// confirmation step.

async function settingsOf({ tx, orgId }: OrgContext, userId: string): Promise<{ address: string | null; digest: boolean }> {
  const [row] = await tx
    .select({ address: users.email, digest: users.digestEnabled })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.id, userId)));
  if (row === undefined) throw new Error("A signed-in member has no user.");
  return row;
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
};
