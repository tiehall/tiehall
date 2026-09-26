import { setWriteBudget } from "@tiehall/catalog";
import { nextUtcDay, Refusal, secondsUntil, utcDay, WRITE_LIMITS, writeBudgetChanged } from "@tiehall/core";
import { agentTokenWrites, agentWriteDays, installSettings } from "@tiehall/db";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { Caller } from "./caller.ts";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { OrgContext } from "./with-org.ts";

// The limits on agent writes (agent-safety: Agent writes are limited per token
// and budgeted per install; public-api: One error model for Tiehall's own
// refusals; activity-log: Which actions are security events; design.md,
// Decisions this change rests on: D28 #49; design.md, Technical decisions:
// T14; design.md, Readings to confirm with the founder: R15). execute()
// counts every call made with an OAuth token or a personal access token that
// writes, in the call's own transaction, before its change:
// - per token, within any 60 seconds: the token's writes are locked while one
//   is counted, those of the last 60 seconds are counted, and a 61st gets 429
//   with Retry-After, the seconds until the oldest of them is a minute old;
// - per install, per UTC day: the day's count takes one more only while it is
//   under the budget, holding the day's row, and otherwise the write gets 429
//   with Retry-After, the seconds until the next UTC day.
// A refused write rolls back and is not counted; so does a write that fails
// later. Writes of web sessions, the system and integrations are not counted,
// and acknowledgements and reads write nothing, so neither meets a limit. An
// OAuth token counts as its grant, one client acting for one user, so that
// refreshing the access token does not start the count again.
//
// The budget is 5,000 until an admin changes it in the web UI, with the
// confirmation step; the change is a security event.

/** The key a token's writes are counted by; undefined for a caller that is no agent token. */
export function tokenKeyOf(caller: Caller): string | undefined {
  switch (caller.kind) {
    case "personal_access_token":
      return `pat:${caller.tokenId}`;
    case "oauth_token":
      return `oauth:${caller.clientId}:${caller.userId}`;
    default:
      return undefined;
  }
}

/** The install's daily write budget. */
export async function dailyWriteBudgetOf({ tx, orgId }: OrgContext, lock = false): Promise<number> {
  const query = tx.select({ budget: installSettings.dailyWriteBudget }).from(installSettings).where(eq(installSettings.orgId, orgId));
  const [row] = lock ? await query.for("update") : await query;
  return row?.budget ?? WRITE_LIMITS.defaultDailyWriteBudget;
}

/** Counts an agent token's write against its limit and the install's budget, or refuses it with 429. */
export async function countTokenWrite(context: OrgContext, token: string, now: Date): Promise<void> {
  const { tx, orgId } = context;
  // The token's writes are counted one at a time, so two at once cannot both take its last place.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId} agent token ${token}`}, 0))`);
  const windowStart = new Date(now.getTime() - WRITE_LIMITS.tokenWindowMs);
  const ofToken = and(eq(agentTokenWrites.orgId, orgId), eq(agentTokenWrites.token, token));
  await tx.delete(agentTokenWrites).where(and(ofToken, lte(agentTokenWrites.writtenAt, windowStart)));
  const recent = await tx
    .select({ writtenAt: agentTokenWrites.writtenAt })
    .from(agentTokenWrites)
    .where(and(ofToken, gt(agentTokenWrites.writtenAt, windowStart)))
    .orderBy(asc(agentTokenWrites.writtenAt));
  const [oldest] = recent;
  if (oldest !== undefined && recent.length >= WRITE_LIMITS.tokenWritesPerWindow) {
    throw new Refusal("rate-limited", "This token has made 60 writes in the last minute; it can write again once the oldest of them is a minute old.", {
      retryAfterSeconds: secondsUntil(now, new Date(oldest.writtenAt.getTime() + WRITE_LIMITS.tokenWindowMs)),
    });
  }
  await tx.insert(agentTokenWrites).values({ orgId, token, writtenAt: now });

  const budget = await dailyWriteBudgetOf(context);
  const [counted] = await tx
    .insert(agentWriteDays)
    .values({ orgId, day: utcDay(now), writes: 1 })
    .onConflictDoUpdate({
      target: [agentWriteDays.orgId, agentWriteDays.day],
      set: { writes: sql`${agentWriteDays.writes} + 1` },
      setWhere: sql`${agentWriteDays.writes} < ${budget}`,
    })
    .returning({ writes: agentWriteDays.writes });
  if (counted === undefined) {
    throw new Refusal("rate-limited", "The install's agents have used today's write budget; agents can write again when the next UTC day begins.", {
      retryAfterSeconds: secondsUntil(now, nextUtcDay(now)),
    });
  }
}

const number = (value: number) => value.toLocaleString("en-US");

export const WRITE_LIMIT_HANDLERS: Handlers = {
  [setWriteBudget.id]: defineHandler(setWriteBudget, async ({ dailyWriteBudget }, context) => {
    const previousBudget = await dailyWriteBudgetOf(context, true);
    if (previousBudget === dailyWriteBudget) return { dailyWriteBudget, previousBudget };
    return context.write(async (writer) => {
      await writer.tx
        .insert(installSettings)
        .values({ orgId: writer.orgId, dailyWriteBudget })
        .onConflictDoUpdate({ target: installSettings.orgId, set: { dailyWriteBudget } });
      await writer.record(writeBudgetChanged, { budget: dailyWriteBudget, previousBudget });
      return { dailyWriteBudget, previousBudget };
    });
  }),
};

/** The review page of a change to the budget, in Tiehall's own words. */
export const WRITE_LIMIT_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [setWriteBudget.id]: async (input, context) => {
    const { dailyWriteBudget } = input as { dailyWriteBudget: number };
    const current = await dailyWriteBudgetOf(context);
    const lines =
      current === dailyWriteBudget
        ? [{ text: `The install's daily budget of agent writes is already ${number(current)}, so confirming changes nothing.` }]
        : [
            { text: `Change the install's daily budget of agent writes from ${number(current)} to ${number(dailyWriteBudget)}.` },
            {
              text: `From then on, the install's agents may make at most ${number(dailyWriteBudget)} writes per UTC day, and each write beyond it gets 429 until the next UTC day begins.`,
            },
          ];
    return { title: "Change the daily write budget", lines };
  },
};
