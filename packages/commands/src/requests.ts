import {
  claimRequest,
  createRequest,
  getRequest,
  listInbox,
  listOpenedRequests,
  listRequests,
  proposeCommitment,
  setRequestStatus,
  type IntakeField,
  type Packet,
} from "@tiehall/catalog";
import { isTerminalState, Refusal, requestClaimed, requestOpened, requestReleased, requestStarted, type RefusalIssue } from "@tiehall/core";
import { requests, teams } from "@tiehall/db";
import { requiredFieldsText } from "@tiehall/packet/tool-text";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { defineHandler, type HandlerContext, type Handlers } from "./execute.ts";
import { teamsOfMember, type MemberTeam } from "./members.ts";
import { insertPacketRevision } from "./packet-revisions.ts";
import type { ProposalAnswer } from "./proposals.ts";
import { actingUserOf, assertSideAllows, lifecycleOf, lockRequest, saveLifecycle, stampOf, teamActedFor, transition } from "./request-changes.ts";
import { resolveRequestKey, teamOfKey } from "./request-keys.ts";
import { takeRequestNumber } from "./request-numbers.ts";
import { requestView, requestViews, threadOf } from "./request-views.ts";
import { capAgentOpenedRequest, recordAgentOpenedRequest } from "./write-limits.ts";

// The request operations (requests: A request is addressed to a team of the
// install; requests: The requester picks the requesting team; requests:
// Request states; requests: Per-team request keys; requests: The event log;
// design.md, Decisions this change rests on: D25, D28 #11; design.md,
// Readings to confirm with the founder: R14).
//
// Reading: every member sees every request, whichever teams they belong to, so
// the reads check no side. A key written with a team's earlier key names the
// same request, which comes back under its current key.
//
// Changing a request goes through request-changes.ts: the request's row is
// locked, the side rules answer 403 and the state machine 409. Claiming,
// starting work and releasing a claim need no proposal: the change and its
// event commit together. Declining and marking done through set_status are
// commitments (requests: Commitments become proposals): once the side rules
// and the state machine allow them, they create a proposal and leave the
// request as it is; marking done a request that is done already, such as by
// close on merge, answers with the request and proposes nothing
// (agent-surfaces: Commitment tools return proposals). requests.propose makes
// the commitments no other operation makes, which are, so far, reassigning a
// request to another team of the install, a proposal of a member of its target
// team (requests: Reassignment gives a new key and the old key redirects), and
// withdrawing it, a proposal of its requester side, each for a request that
// has not ended.
//
// The inbox (agent-surfaces: The MCP tools; design.md, Decisions this change
// rests on: D28 #56): list_inbox lists the requests addressed to the caller's
// teams, newest first, in every state unless it names one; a member of no team
// has none. The web UI's request lists read it too, beside every request of
// the install and the requests the caller's user opened, newest first, which
// an internal read lists for them and no agent surface offers (requests: Every
// member sees every request).
//
// Opening a request: it is addressed to one team of the install, and a team
// the install does not have gets 404. The requester picks the team they open
// it from among their own: their only team is the default; a member of
// several teams who names none gets 400, which lists the teams to pick from; a
// member of no team, and one who names a team they are not in, gets 403. The
// request starts open with the next number of its target team, and with its
// packet, as the catalog's definition parsed it, as revision 1 (handoff-packet:
// Immutable, numbered revisions; handoff-packet: Open objects, strict server);
// the request, its number, its first revision and its event commit together or
// not at all. A request an agent opens counts toward the caps on agent-opened
// requests, and one beyond them is not opened (agent-safety: Agent-opened
// requests are capped).
//
// A request that lacks a field its target team requires is refused, whether
// an agent opens it through open_request or /api/v1, which `tiehall open`
// calls, or a person through the web form (agent-surfaces: Requests missing a
// team's required fields are refused; design.md, Decisions this change rests
// on: D28 #26; design.md, Readings to confirm with the founder: R10): as input
// that fails the schema, with 400, whose errors name each missing field, in
// the order the team's intake page lists them, and nothing is created. A list
// with no item, such as no acceptance criteria, counts as none. Only the
// requests people and agents open go through requests.create; a contract
// report opens its requests without it, so they are not held to these fields.

/** What each state set_status names does: start work, release the claim, or propose to decline or to mark done. */
const STATUS_ACTIONS = { in_progress: "start", open: "release", declined: "decline", done: "mark_done" } as const;

/** "BE", "BE and QA", or "BE, OPS and QA". */
function listed(keys: readonly string[]): string {
  return keys.length <= 2 ? keys.join(" and ") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

/** The team the user opens a request from: the one they name, which must be theirs, or their only team. */
async function requestingTeamOf(context: HandlerContext, userId: string, named: string | undefined): Promise<MemberTeam> {
  const mine = await teamsOfMember(context, userId);
  if (named !== undefined) {
    const team = await teamOfKey(context, named);
    const own = team === undefined ? undefined : mine.find(({ id }) => id === team.id);
    if (own === undefined) throw new Refusal("forbidden", "You can open a request only from a team you belong to.");
    return own;
  }
  const [only, ...others] = mine;
  if (only === undefined) {
    throw new Refusal("forbidden", "You belong to no team, so you cannot open a request until an admin adds you to one.");
  }
  if (others.length > 0) {
    const keys = mine.map(({ key }) => key);
    throw new Refusal("invalid-input", `You belong to ${listed(keys)}; name the team you open the request from as requestingTeam.`, {
      issues: [{ path: ["requestingTeam"], message: `Name one of your teams: ${keys.join(", ")}.` }],
    });
  }
  return only;
}

/** Where each field a team may require sits in requests.create's input, and whether a packet has it. */
const REQUIRED_FIELD_CHECKS: Readonly<Record<IntakeField, { path: string[]; has: (packet: Packet) => boolean }>> = {
  acceptance_criteria: { path: ["packet", "untrusted", "acceptance_criteria"], has: (packet) => (packet.untrusted.acceptance_criteria?.length ?? 0) > 0 },
  code_refs: { path: ["packet", "untrusted", "code_refs"], has: (packet) => (packet.untrusted.code_refs?.length ?? 0) > 0 },
  links: { path: ["packet", "untrusted", "links"], has: (packet) => (packet.untrusted.links?.length ?? 0) > 0 },
  due_date: { path: ["packet", "due_date"], has: (packet) => packet.due_date !== undefined },
};

/** Refuses a packet that lacks a field the target team requires, with 400 naming each; the team's fields are read in the call's transaction. */
async function assertRequiredFields({ tx, orgId }: HandlerContext, target: { id: string; key: string }, packet: Packet): Promise<void> {
  const [row] = await tx
    .select({ requiredFields: teams.requiredFields })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.id, target.id)));
  const missing = ((row?.requiredFields ?? []) as IntakeField[]).filter((field) => !REQUIRED_FIELD_CHECKS[field].has(packet));
  if (missing.length === 0) return;
  const issues: RefusalIssue[] = missing.map((field) => ({ path: REQUIRED_FIELD_CHECKS[field].path, message: `Team ${target.key} requires ${requiredFieldsText([field])}.` }));
  throw new Refusal("invalid-input", `Team ${target.key} requires ${requiredFieldsText(missing)} of the requests opened to it, which this packet lacks, so nothing was opened.`, {
    issues,
  });
}

/** Proposes withdrawing the request, as its requester side, while its state allows a withdrawal. */
export async function proposeWithdrawal(context: HandlerContext, key: string): Promise<ProposalAnswer> {
  const userId = actingUserOf(context);
  const row = await lockRequest(context, key);
  await assertSideAllows(context, userId, row, "withdraw");
  transition(await lifecycleOf(context, row), { kind: "withdraw" });
  return context.propose(row, { kind: "withdraw", change: {} });
}

/** Proposes reassigning the request to another team of the install, as a member of its target team, while it has not ended. */
export async function proposeReassignment(context: HandlerContext, key: string, teamKey: string): Promise<ProposalAnswer> {
  const userId = actingUserOf(context);
  const row = await lockRequest(context, key);
  await assertSideAllows(context, userId, row, "reassign");
  const team = await teamOfKey(context, teamKey);
  if (team === undefined) throw new Refusal("record-not-found", "There is no such team.");
  if (team.id === row.targetTeamId) {
    const message = "A request is reassigned to another team than the one it is addressed to.";
    throw new Refusal("invalid-input", message, { issues: [{ path: ["team"], message }] });
  }
  const current = await lifecycleOf(context, row);
  if (isTerminalState(current.state)) {
    throw new Refusal("conflict", `The request is ${current.state}, which is final, so it is no longer reassigned.`);
  }
  return context.propose(row, { kind: "reassign", change: { teamId: team.id } });
}

export const REQUEST_HANDLERS: Handlers = {
  [createRequest.id]: defineHandler(createRequest, async ({ targetTeam, requestingTeam, title, packet }, context) => {
    const userId = actingUserOf(context);
    const target = await teamOfKey(context, targetTeam);
    if (target === undefined) throw new Refusal("record-not-found", "There is no such team.");
    const from = await requestingTeamOf(context, userId, requestingTeam);
    await assertRequiredFields(context, target, packet as Packet);
    const opening = { userId, requestingTeamId: from.id, targetTeamId: target.id };
    const byAgent = context.provenance.actorKind === "agent";
    return context.write(async (writer) => {
      if (byAgent) await capAgentOpenedRequest(writer, opening, writer.now());
      const number = await takeRequestNumber(writer, target.id);
      const [row] = await writer.tx
        .insert(requests)
        .values({ orgId: writer.orgId, targetTeamId: target.id, number, title, requestingUserId: userId, requestingTeamId: from.id })
        .returning({ id: requests.id });
      if (row === undefined) throw new Error("The new request was not returned.");
      if (byAgent) await recordAgentOpenedRequest(writer, row.id, opening, writer.now());
      await insertPacketRevision(writer, row.id, 1, packet, stampOf(context.provenance, from.id));
      await writer.record(requestOpened, { requestId: row.id, targetTeamId: target.id, requestingTeamId: from.id });
      return requestView(writer, row.id);
    }, { teamId: from.id });
  }),

  [getRequest.id]: defineHandler(getRequest, async ({ key }, context) => {
    const { requestId } = await resolveRequestKey(context, key);
    return { ...(await requestView(context, requestId)), messages: await threadOf(context, requestId) };
  }),

  [listRequests.id]: defineHandler(listRequests, async ({ targetTeam, state, limit, offset }, context) => {
    const where: SQL[] = [eq(requests.orgId, context.orgId)];
    if (targetTeam !== undefined) {
      const team = await teamOfKey(context, targetTeam);
      if (team === undefined) throw new Refusal("record-not-found", "There is no such team.");
      where.push(eq(requests.targetTeamId, team.id));
    }
    if (state !== undefined) where.push(eq(requests.state, state));
    const rows = await context.tx
      .select()
      .from(requests)
      .where(and(...where))
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(limit ?? 50)
      .offset(offset ?? 0);
    return { "requests": await requestViews(context, rows) };
  }),

  // The inbox of an agent's user: the requests addressed to any of the user's teams, newest first.
  [listInbox.id]: defineHandler(listInbox, async ({ state, limit, offset }, context) => {
    const mine = await teamsOfMember(context, actingUserOf(context));
    if (mine.length === 0) return { "requests": [] };
    const where: SQL[] = [
      eq(requests.orgId, context.orgId),
      inArray(
        requests.targetTeamId,
        mine.map(({ id }) => id),
      ),
    ];
    if (state !== undefined) where.push(eq(requests.state, state));
    const rows = await context.tx
      .select()
      .from(requests)
      .where(and(...where))
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(limit ?? 20)
      .offset(offset ?? 0);
    return { "requests": await requestViews(context, rows) };
  }),

  // The requests the caller's user opened, newest first, for the web UI's request lists.
  [listOpenedRequests.id]: defineHandler(listOpenedRequests, async ({ state, limit, offset }, context) => {
    const where: SQL[] = [eq(requests.orgId, context.orgId), eq(requests.requestingUserId, actingUserOf(context))];
    if (state !== undefined) where.push(eq(requests.state, state));
    const rows = await context.tx
      .select()
      .from(requests)
      .where(and(...where))
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(limit ?? 50)
      .offset(offset ?? 0);
    return { "requests": await requestViews(context, rows) };
  }),

  [claimRequest.id]: defineHandler(claimRequest, async ({ key }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    await assertSideAllows(context, userId, row, "claim");
    const next = transition(await lifecycleOf(context, row), { kind: "claim", userId });
    const teamId = await teamActedFor(context, userId, row, "target");
    return context.write(async (writer) => {
      await writer.changesRequest(row.id);
      await saveLifecycle(writer, row.id, next);
      // When it was claimed, by the database's clock, which close on merge compares a merge with (close-on-merge.ts).
      await writer.tx
        .update(requests)
        .set({ claimedAt: sql`now()` })
        .where(and(eq(requests.orgId, writer.orgId), eq(requests.id, row.id)));
      await writer.record(requestClaimed, { requestId: row.id, userId });
      return requestView(writer, row.id);
    }, { teamId });
  }),

  [proposeCommitment.id]: defineHandler(proposeCommitment, async (input, context) =>
    input.kind === "withdraw" ? proposeWithdrawal(context, input.key) : proposeReassignment(context, input.key, input.team),
  ),

  [setRequestStatus.id]: defineHandler(setRequestStatus, async ({ key, state }, context) => {
    const userId = actingUserOf(context);
    const row = await lockRequest(context, key);
    const action = STATUS_ACTIONS[state];
    await assertSideAllows(context, userId, row, action);
    const current = await lifecycleOf(context, row);
    // Declining and marking done are commitments: a proposal, once the request's state allows the change.
    if (action === "decline" || action === "mark_done") {
      if (action === "mark_done" && current.state === "done") return requestView(context, row.id);
      transition(current, { kind: action === "decline" ? "decline" : "done" });
      return context.propose(row, { kind: action === "decline" ? "decline" : "done", change: {} });
    }
    const next = transition(current, { kind: action });
    const teamId = await teamActedFor(context, userId, row, "target");
    return context.write(async (writer) => {
      await writer.changesRequest(row.id);
      await saveLifecycle(writer, row.id, next);
      if (action === "release" && current.claimantId !== null) {
        await writer.record(requestReleased, { requestId: row.id, userId: current.claimantId });
      } else {
        await writer.record(requestStarted, { requestId: row.id });
      }
      return requestView(writer, row.id);
    }, { teamId });
  }),
};
