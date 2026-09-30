import { recordedTrustState, TRUST_STATE_EVENT_TYPES, trustDifferences, trustStateReconciled, type Role, type TrustEvent, type TrustState } from "@tiehall/core";
import { events, eventSequence, members, oauthConsents } from "@tiehall/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { defineJobType } from "./jobs.ts";
import { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
import type { WorkerJob } from "./worker.ts";
import { writeIn } from "./write.ts";

// Trust-state changes are reconciled every night (activity-log: Trust-state
// changes are reconciled every night; activity-log: Which actions are security
// events; design.md, Technical decisions: T6 and T8; design.md, Self-hosting
// decisions: S14). Each night a worker job compares the install's members,
// their roles and the agent-client grants with what the security events
// record, replayed in order (packages/core, trust-state.ts), and appends one
// `activity_log.reconciled` security event, as the system's, for each
// difference it finds: a member whose membership or role no event records, a
// recorded member who is gone, or a grant that is present or gone without its
// event. So a change stored without its event, for example one lost between a
// write the sign-in service owns and its event, still reaches the activity
// log, and the next comparison finds nothing. A clean state adds no event.
//
// The job holds the org's event counter while it reads, so no change can
// commit with its event between the state it reads and the events it reads,
// and no event can take a number between the comparison and the events it
// appends.
//
// The agent-client grants are the grants a member's approval stores
// (agent-grants.ts), which the replay reads from their approval and
// revocation events and from the `reconciled` events that record one.

export const reconcileTrustState: WorkerJob<Record<string, never>> = {
  type: defineJobType<Record<string, never>>("activity_log.reconcile", 1, {
    retryLimit: 3,
    retryDelaySeconds: 600,
    retryBackoff: false,
    expireInSeconds: 600,
  }),
  schedule: "45 2 * * *",
  async handle(_job, { database }) {
    try {
      await withOrg(database, async (context) => {
        await holdEventSequence(context);
        const differences = trustDifferences(await currentTrustState(context), recordedTrustState(await recordedEvents(context)));
        if (differences.length === 0) return;
        const jobs = {
          send: async () => {
            throw new Error("Reconciling the trust state starts no job.");
          },
        };
        await writeIn(context, jobs, { actorKind: "system" }, async (writer) => {
          for (const difference of differences) await writer.record(trustStateReconciled, difference);
        });
      });
    } catch (error) {
      // Before setup there is no org, and so no member and no event.
      if (!(error instanceof SetupRequiredError)) throw error;
    }
  },
};

/** Locks the org's event counter until the transaction ends; before the first event there is none to lock. */
async function holdEventSequence({ tx, orgId }: OrgContext): Promise<void> {
  await tx.select({ lastNumber: eventSequence.lastNumber }).from(eventSequence).where(eq(eventSequence.orgId, orgId)).for("update");
}

/** The install's members in their roles now, and its agent-client grants, each for the member who approved it. */
export async function currentTrustState({ tx, orgId }: OrgContext): Promise<TrustState> {
  const rows = await tx.select({ userId: members.userId, role: members.role }).from(members).where(eq(members.orgId, orgId)).orderBy(asc(members.userId));
  const grants = await tx
    .select({ grantId: oauthConsents.id, userId: oauthConsents.userId })
    .from(oauthConsents)
    .where(eq(oauthConsents.orgId, orgId))
    .orderBy(asc(oauthConsents.id));
  return {
    members: rows.map(({ userId, role }) => ({ userId, role: role as Role })),
    grants: grants.flatMap(({ grantId, userId }) => (userId === null ? [] : [{ grantId, userId }])),
  };
}

/** The security events the replay reads, oldest first. */
async function recordedEvents({ tx, orgId }: OrgContext): Promise<TrustEvent[]> {
  const rows = await tx
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.class, "security"), inArray(events.type, [...TRUST_STATE_EVENT_TYPES])))
    .orderBy(asc(events.number));
  return rows.map(({ type, data }) => ({ type, data: data as Readonly<Record<string, unknown>> }));
}
