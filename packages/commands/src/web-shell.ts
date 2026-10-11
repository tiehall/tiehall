import { webShell } from "@tiehall/catalog";
import { users } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import { defineHandler, type Handlers } from "./execute.ts";
import { waitingByProposal } from "./proposal-waiting.ts";
import { actingUserOf } from "./request-changes.ts";

// web.shell, the read behind the web UI's top bar (web-ui: The page shell and
// its navigation; design.md, Design: The page shell and navigation; D57 (4)):
// the signed-in member's login and bot flag, whether they are an admin, as the
// call's membership re-check read their role, and how many proposals wait for
// their own confirmation now, decided as their web inbox's standing list
// decides it (proposal-waiting.ts). A removed member's call is refused before
// it runs, as every call is.

export const WEB_SHELL_HANDLERS: Handlers = {
  [webShell.id]: defineHandler(webShell, async (_input, context) => {
    const userId = actingUserOf(context);
    const [user] = await context.tx
      .select({ login: users.githubLogin, bot: users.bot })
      .from(users)
      .where(and(eq(users.orgId, context.orgId), eq(users.id, userId)));
    if (user === undefined) throw new Error("A member's call names a user the install does not hold.");
    const waiting = [...(await waitingByProposal(context, context.now())).values()].filter((userIds) => userIds.includes(userId)).length;
    return { login: user.login, kind: "human" as const, bot: user.bot, admin: context.member?.role === "admin", waiting };
  }),
};
