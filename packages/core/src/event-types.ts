import { defineEventType, type EventType } from "./events.ts";
import { CANCEL_REASONS, COMMITMENT_KINDS, PROPOSAL_ENDINGS } from "./proposals.ts";
import { REQUEST_STATES } from "./request-states.ts";
import { ROLES } from "./roles.ts";

// The event types Tiehall writes (requests: The event log; activity-log: Which
// actions are security events). Each task that adds a change adds the type of
// its event here, and a test runs checkEventTypes() over the list.

/**
 * A request was opened (requests: A request is addressed to a team of the
 * install; requests: The event log). It names the request, the team it is
 * addressed to and the team it was opened from; its provenance names the
 * user who opened it.
 */
export const requestOpened = defineEventType({
  type: "request.opened",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    targetTeamId: { kind: "id", of: "team" },
    requestingTeamId: { kind: "id", of: "team" },
  },
});

/**
 * A request was claimed (requests: Claiming and starting work need no
 * proposal). It names the claimant, whom the claim was made for.
 */
export const requestClaimed = defineEventType({
  type: "request.claimed",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    userId: { kind: "id", of: "user" },
  },
});

/** Work on a claimed request started: it moved to in_progress (requests: Claiming and starting work need no proposal). */
export const requestStarted = defineEventType({
  type: "request.started",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
  },
});

/**
 * A claim was released (requests: Allowed state changes). It names the user
 * whose claim it was; its provenance names who released it, the claimant or a
 * member of the target team once the claimant was no longer a member.
 */
export const requestReleased = defineEventType({
  type: "request.released",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    userId: { kind: "id", of: "user" },
  },
});

/**
 * A message posted in a request's thread (requests: Thread messages and
 * blocking questions; requests: Events carry ids, not bodies). It names the
 * request and the message, never its text, which readers fetch through a
 * read; the thread's own messages also say their kind, whether a question
 * blocks, and for an answer the question it answers.
 */
export const messagePosted = defineEventType({
  type: "request.message_posted",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    messageId: { kind: "id", of: "message" },
    kind: { kind: "enum", values: ["comment", "question", "answer"], optional: true },
    blocking: { kind: "boolean", optional: true },
    questionId: { kind: "id", of: "message", optional: true },
  },
});

/**
 * A message was edited: its author added its next version (requests:
 * Messages are append-only; requests: Events carry ids, not bodies). It names
 * the message and the version, never the text.
 */
export const messageEdited = defineEventType({
  type: "request.message_edited",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    messageId: { kind: "id", of: "message" },
    version: { kind: "integer" },
  },
});

/**
 * A revision was added to a request's packet (handoff-packet: Immutable,
 * numbered revisions; requests: Events carry ids, not bodies). It names the
 * request and the new revision's number, never the packet, which readers
 * fetch through a read.
 */
export const requestPacketRevised = defineEventType({
  type: "request.packet_revised",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    revision: { kind: "integer" },
  },
});

/**
 * A request's state changed as the side effect of another change, such as a
 * blocking question moving it to needs_info or the last answer returning it
 * (requests: Thread messages and blocking questions; requests: The event
 * log). It names the state the request left and the one it is in now.
 */
export const requestStateChanged = defineEventType({
  type: "request.state_changed",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    state: { kind: "enum", values: REQUEST_STATES },
    previousState: { kind: "enum", values: REQUEST_STATES },
  },
});

/**
 * Agents made so many writes on a request since the last human action that it
 * now waits for a person (agent-safety: The needs_human flag is visible and
 * reaches the people on the request). Its provenance names the agent write
 * that set the flag.
 */
export const requestNeedsHumanFlagged = defineEventType({
  type: "request.needs_human_flagged",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
  },
});

/**
 * A human action cleared a request's needs_human flag (agent-safety: The
 * needs_human flag is visible and reaches the people on the request). Its
 * provenance names the web session whose message or confirmation cleared it.
 */
export const requestNeedsHumanCleared = defineEventType({
  type: "request.needs_human_cleared",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
  },
});

/**
 * A confirmed reassignment moved a request to another team of the install
 * (requests: Reassignment gives a new key and the old key redirects). It names
 * the request, the team it moved to, which gave it its next key, and the team
 * it left; its provenance names the web session whose confirmation applied it.
 */
export const requestReassigned = defineEventType({
  type: "request.reassigned",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    teamId: { kind: "id", of: "team" },
    previousTeamId: { kind: "id", of: "team" },
  },
});

/**
 * A commitment became a proposal, which takes effect once the people it needs
 * have confirmed it in the web UI (requests: Commitments become proposals;
 * requests: A confirmed commitment applies only if the request still allows
 * it). It names the request, the proposal and the kind of commitment; its
 * provenance names who proposed it, the proposal's accountable human.
 */
export const proposalCreated = defineEventType({
  type: "proposal.created",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    proposalId: { kind: "id", of: "proposal" },
    kind: { kind: "enum", values: COMMITMENT_KINDS },
  },
});

/**
 * A person confirmed a proposal in the web UI (requests: A confirmed commitment
 * applies only if the request still allows it; requests: Cross-team
 * commitments need a confirmation from each side). It names the request, the
 * proposal, the step the confirmation gave, its accountable human's or the
 * other side's, and whether it made the commitment take effect; its
 * provenance names the web session that confirmed it.
 */
export const proposalConfirmed = defineEventType({
  type: "proposal.confirmed",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    proposalId: { kind: "id", of: "proposal" },
    step: { kind: "enum", values: ["accountable_human", "other_side"] },
    applied: { kind: "boolean" },
  },
});

/**
 * A person undid, in the web UI, a commitment that had taken effect within its
 * undo window (requests: The undo window for reversible commitments). It names
 * the request and the proposal; its provenance names the web session that
 * undid it.
 */
export const proposalUndone = defineEventType({
  type: "proposal.undone",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    proposalId: { kind: "id", of: "proposal" },
  },
});

/**
 * A proposal ended without taking effect (requests: How a proposal ends
 * without taking effect; requests: The event log). It names the request, the
 * proposal and how it ended: rejected, withdrawn, expired or cancelled, and,
 * for a cancellation, why; its provenance names who or what ended it.
 */
export const proposalEnded = defineEventType({
  type: "proposal.ended",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    proposalId: { kind: "id", of: "proposal" },
    how: { kind: "enum", values: PROPOSAL_ENDINGS },
    reason: { kind: "enum", values: CANCEL_REASONS, optional: true },
  },
});

/**
 * An admin changed a member's role (teams-and-roles: Changing a member's role;
 * activity-log: Which actions are security events). It names the member and
 * the role they had and now have; its provenance names the admin.
 */
export const memberRoleChanged = defineEventType({
  type: "member.role_changed",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    role: { kind: "enum", values: ROLES },
    previousRole: { kind: "enum", values: ROLES },
  },
});

/**
 * A member was removed from the install (teams-and-roles: Removing a member;
 * activity-log: Which actions are security events). It names the member, and
 * whether an admin removed them, which records a block on their GitHub
 * account, or they were removed because they left the GitHub organization,
 * which records none; for an admin removal its provenance names the admin.
 */
export const memberRemoved = defineEventType({
  type: "member.removed",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    cause: { kind: "enum", values: ["admin", "left_organization"] },
    blocked: { kind: "boolean" },
  },
});

/**
 * An admin changed the install's daily budget of agent writes (agent-safety:
 * Agent writes are limited per token and budgeted per install; activity-log:
 * Which actions are security events). It names the budget before and after;
 * its provenance names the admin.
 */
export const writeBudgetChanged = defineEventType({
  type: "settings.write_budget_changed",
  class: "security",
  fields: {
    budget: { kind: "integer" },
    previousBudget: { kind: "integer" },
  },
});

/**
 * The nightly comparison found a member, a role or an agent-client grant that
 * the security events did not record, and recorded it (activity-log:
 * Trust-state changes are reconciled every night; activity-log: Which actions
 * are security events). It names what differs: a member, by their user, who
 * is present in the role they hold now or is no longer a member, or a grant,
 * by its id and its user, that is present or gone; its provenance is the
 * system's. A later comparison takes it as the recorded state.
 */
export const trustStateReconciled = defineEventType({
  type: "activity_log.reconciled",
  class: "security",
  fields: {
    subject: { kind: "enum", values: ["member", "grant"] },
    userId: { kind: "id", of: "user" },
    present: { kind: "boolean" },
    role: { kind: "enum", values: ROLES, optional: true },
    grantId: { kind: "id", of: "grant", optional: true },
  },
});

/**
 * An admin exported the activity log (activity-log: Exporting the activity
 * log; activity-log: Which actions are security events). It names the number
 * of the last event the export holds; its provenance names the admin's web
 * session, since the export takes the confirmation step.
 */
export const activityLogExported = defineEventType({
  type: "activity_log.exported",
  class: "security",
  fields: {
    lastNumber: { kind: "integer" },
  },
});

export const EVENT_TYPES: readonly EventType[] = [
  requestOpened,
  requestClaimed,
  requestStarted,
  requestReleased,
  messagePosted,
  messageEdited,
  requestPacketRevised,
  requestStateChanged,
  requestNeedsHumanFlagged,
  requestNeedsHumanCleared,
  requestReassigned,
  proposalCreated,
  proposalConfirmed,
  proposalUndone,
  proposalEnded,
  memberRoleChanged,
  memberRemoved,
  writeBudgetChanged,
  trustStateReconciled,
  activityLogExported,
];
