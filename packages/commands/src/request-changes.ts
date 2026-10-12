import {
  changeRequest,
  Refusal,
  sideAllows,
  whoMay,
  type RequestAction,
  type RequestChange,
  type RequestLifecycle,
  type RequestParties,
  type RequestState,
  type ResumableState,
  type Provenance,
} from "@tiehall/core";
import { requests } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { HandlerContext } from "./execute.ts";
import { memberOf, teamsOfMember } from "./members.ts";
import { noSuchRequest, resolveRequestKey } from "./request-keys.ts";
import { openBlockingQuestionsOf, type RequestRow } from "./request-views.ts";
import type { OrgContext } from "./with-org.ts";

// Changing a request (requests: Which side may act on a request; requests:
// Allowed state changes; requests: Request states; design.md, Decisions this
// change rests on: D28 #3, #13). Each change locks the request's row first, so
// changes to one request run one after the other and each sees the one before
// it. The caller's side must allow the action, or it gets 403 (the side rules
// in packages/core); then the request's state must allow the change, or it
// gets 409 (the state machine in packages/core). Either refusal changes
// nothing.

/** The user a call acts for. The request operations run only for a caller that acts for a user. */
export function actingUserOf(context: HandlerContext): string {
  const userId = context.member?.userId;
  if (userId === undefined) throw new Error("A request operation runs only for a caller that acts for a user.");
  return userId;
}

/** The request a key names, with its row locked until the call's transaction ends; 404 when the key names none. */
export async function lockRequest(context: OrgContext, key: string): Promise<RequestRow> {
  const { requestId } = await resolveRequestKey(context, key);
  return lockRequestById(context, requestId);
}

/** The request, with its row locked until the call's transaction ends; 404 when the install has no such request. */
export async function lockRequestById(context: OrgContext, requestId: string): Promise<RequestRow> {
  const [row] = await context.tx
    .select()
    .from(requests)
    .where(and(eq(requests.orgId, context.orgId), eq(requests.id, requestId)))
    .for("update");
  if (row === undefined) throw noSuchRequest();
  return row;
}

/** Who the request's parties are, as the side rules see them, with whether its claimant is still a member. */
export async function partiesOf(context: OrgContext, row: RequestRow): Promise<RequestParties> {
  const claimantIsMember = row.claimantUserId !== null && (await memberOf(context, row.claimantUserId)) !== undefined;
  return {
    targetTeamId: row.targetTeamId,
    requestingTeamId: row.requestingTeamId,
    requestingUserId: row.requestingUserId,
    claimantId: row.claimantUserId,
    claimantIsMember,
  };
}

/** Refuses, with 403, an action the user's side of the request does not allow. */
export async function assertSideAllows(context: OrgContext, userId: string, row: RequestRow, action: RequestAction): Promise<void> {
  const teamIds = (await teamsOfMember(context, userId)).map(({ id }) => id);
  if (!sideAllows({ userId, teamIds }, await partiesOf(context, row), action)) throw new Refusal("forbidden", whoMay(action));
}

/**
 * The team a user acts for on a request, which provenance records: the
 * requesting team for the user who opened it, otherwise the target team or the
 * requesting team they belong to; none for someone on neither side now, such as
 * a claimant who has left the target team. An action of the target team's,
 * such as a claim, names the target team when the user belongs to it. A
 * message takes the claim first (requests: The side a message is posted for;
 * findings-from-claude-code-run: design.md, Findings: F4 (7); design.md,
 * Technical decisions: T5): the request's claimant, while a member of its
 * target team, posts for the target team, even when they opened the request
 * or belong to its requesting team, since they work on it as its claimant.
 */
export async function teamActedFor(
  context: OrgContext,
  userId: string,
  row: RequestRow,
  side: "either" | "target" | "message" = "either",
): Promise<string | undefined> {
  const teamIds = (await teamsOfMember(context, userId)).map(({ id }) => id);
  if (side === "message" && row.claimantUserId === userId && teamIds.includes(row.targetTeamId)) return row.targetTeamId;
  if (side !== "target" && row.requestingUserId === userId) return row.requestingTeamId;
  if (teamIds.includes(row.targetTeamId)) return row.targetTeamId;
  if (side !== "target" && teamIds.includes(row.requestingTeamId)) return row.requestingTeamId;
  return undefined;
}

/** Where the request is in its lifecycle, as the state machine sees it, with its unanswered blocking questions. */
export async function lifecycleOf(context: OrgContext, row: RequestRow): Promise<RequestLifecycle> {
  return {
    state: row.state as RequestState,
    claimantId: row.claimantUserId,
    resumeState: row.resumeState as ResumableState | null,
    openBlockingQuestions: await openBlockingQuestionsOf(context, row.id),
  };
}

/** Where the change takes the request; 409 when its state does not allow it. */
export function transition(current: RequestLifecycle, change: RequestChange): RequestLifecycle {
  const result = changeRequest(current, change);
  if (!result.ok) throw new Refusal("conflict", result.conflict);
  return result.next;
}

/** Stores where the request is now in its lifecycle. */
export async function saveLifecycle({ tx, orgId }: OrgContext, requestId: string, next: RequestLifecycle): Promise<void> {
  await tx
    .update(requests)
    .set({ state: next.state, claimantUserId: next.claimantId, resumeState: next.resumeState })
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
}

/**
 * The provenance columns of a message or a packet revision: the caller's, as
 * execute() stamped it, never the payload's, and the team the user acted for.
 */
export function stampOf(provenance: Provenance, teamId: string | undefined) {
  if (provenance.actorKind === "operator") throw new Error("An operator command changes no request.");
  return {
    actorKind: provenance.actorKind,
    actorUserId: provenance.userId ?? null,
    client: provenance.client ?? null,
    surface: provenance.surface ?? null,
    teamId: teamId ?? null,
  };
}
