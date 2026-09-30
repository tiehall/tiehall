import { defineEventType, type EventType } from "./events.ts";
import { CANCEL_REASONS, COMMITMENT_KINDS, PROPOSAL_ENDINGS } from "./proposals.ts";
import { REQUEST_STATES } from "./request-states.ts";
import { ROLES } from "./roles.ts";
import { SIGN_IN_POLICIES } from "./sign-in-policy.ts";

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
 * sign-in: Leaving the GitHub organization ends access; activity-log: Which
 * actions are security events). It names the member, and whether an admin
 * removed them, which records a block on their GitHub account, or they were
 * removed because they left the GitHub organization, which records none; for
 * that cause it names the connected installation whose organization GitHub
 * reported them gone from. For an admin removal its provenance names the
 * admin; for leaving, the integration or the system job that found it.
 */
export const memberRemoved = defineEventType({
  type: "member.removed",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    cause: { kind: "enum", values: ["admin", "left_organization"] },
    blocked: { kind: "boolean" },
    installationId: { kind: "id", of: "installation", optional: true },
  },
});

/**
 * A sign-in admitted a person who was not a member of the install, and they
 * joined it (sign-in: Who may sign in; sign-in: New members join as members;
 * activity-log: Which actions are security events): through a valid invite,
 * which the sign-in accepted and which gives their role, or through
 * membership of a GitHub organization whose installation an admin connected,
 * as a member. It names the new member, their role, the way they came in and,
 * for an invite, the invite, and says when accepting that invite cleared the
 * block an admin removal recorded on their GitHub account (sign-in: An admin
 * removal blocks rejoining through the organization); its provenance names
 * their user, whose sign-in it was. It is recorded together with the
 * membership, and the clearing, before the sign-in's own event.
 */
export const memberJoined = defineEventType({
  type: "member.joined",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    role: { kind: "enum", values: ROLES },
    through: { kind: "enum", values: ["invite", "organization"] },
    inviteId: { kind: "id", of: "invite", optional: true },
    blockCleared: { kind: "boolean", optional: true },
  },
});

/**
 * An admin invited a person by their GitHub username (teams-and-roles:
 * Invites by GitHub username; activity-log: Which actions are security
 * events). It names the invite, which holds the GitHub account it is bound
 * to, and the role it gives; its provenance names the admin, whose web
 * session confirmed it.
 */
export const inviteCreated = defineEventType({
  type: "invite.created",
  class: "security",
  fields: {
    inviteId: { kind: "id", of: "invite" },
    role: { kind: "enum", values: ROLES },
  },
});

/**
 * An admin revoked a pending invite (teams-and-roles: Revoking an invite;
 * activity-log: Which actions are security events). It names the invite; its
 * provenance names the admin.
 */
export const inviteRevoked = defineEventType({
  type: "invite.revoked",
  class: "security",
  fields: {
    inviteId: { kind: "id", of: "invite" },
  },
});

/**
 * An admin changed the install's sign-in policy (sign-in: The sign-in policy;
 * activity-log: Which actions are security events). It names the setting
 * before and after; its provenance names the admin.
 */
export const signInPolicyChanged = defineEventType({
  type: "settings.sign_in_policy_changed",
  class: "security",
  fields: {
    policy: { kind: "enum", values: SIGN_IN_POLICIES },
    previousPolicy: { kind: "enum", values: SIGN_IN_POLICIES },
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

/**
 * A person signed in with GitHub (activity-log: Which actions are security
 * events; activity-log: Writes the sign-in service owns are still recorded).
 * It names the user, and says when the sign-in cleared the block an admin
 * removal recorded on their GitHub account, by accepting an invite created
 * after the removal; its provenance names their new web session's user, and
 * the side table keeps the client's address and user agent.
 */
export const signInCompleted = defineEventType({
  type: "sign_in.completed",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    blockCleared: { kind: "boolean", optional: true },
  },
});

/**
 * A GitHub account was refused at sign-in (sign-in: Who may sign in;
 * activity-log: Which actions are security events). It names the record of
 * the refusal, which holds the GitHub account, and the account's user when
 * Tiehall knows one, such as a removed member's; its provenance is the
 * system's, since no user acted.
 */
export const signInRefused = defineEventType({
  type: "sign_in.refused",
  class: "security",
  fields: {
    refusalId: { kind: "id", of: "sign_in_refusal" },
    userId: { kind: "id", of: "user", optional: true },
  },
});

/**
 * The first admin's sign-in completed setup (self-host-install: Setup names
 * the company and makes the first admin; activity-log: Which actions are
 * security events). It names the first admin, who joined the install as an
 * admin with it; its provenance names their web session's user.
 */
export const setupCompleted = defineEventType({
  type: "setup.completed",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
  },
});

/**
 * An installation of the install's GitHub App was connected (tracker-mirrors:
 * Admins connect GitHub installations with the confirmation step;
 * activity-log: Which actions are security events): by an admin, with the
 * confirmation step, or by the sign-in that completed setup. It names Tiehall's
 * record of the installation; its provenance names who connected it.
 */
export const githubInstallationConnected = defineEventType({
  type: "github.installation_connected",
  class: "security",
  fields: {
    installationId: { kind: "id", of: "installation" },
  },
});

/**
 * An admin disconnected an installation of the install's GitHub App
 * (tracker-mirrors: Admins connect GitHub installations with the confirmation
 * step; activity-log: Which actions are security events). It names Tiehall's
 * record of the installation; its provenance names the admin.
 */
export const githubInstallationDisconnected = defineEventType({
  type: "github.installation_disconnected",
  class: "security",
  fields: {
    installationId: { kind: "id", of: "installation" },
  },
});

/** GitHub's two modes (tracker-mirrors: GitHub and Jira each run in webhook mode or polling mode). */
export const GITHUB_MODES = ["webhook", "polling"] as const;

/**
 * GitHub's mode changed (tracker-mirrors: GitHub and Jira each run in webhook
 * mode or polling mode; activity-log: Which actions are security events): an
 * admin switched it in the web UI, a failed delivery in the App's delivery
 * log after its first installation put GitHub in polling mode, or a delivery
 * the redelivery job gave up did (github-layer-hardening: design.md, Technical
 * decisions: T8). It is a change of the integration; its provenance names the
 * admin, or the system.
 */
export const githubModeChanged = defineEventType({
  type: "github.mode_changed",
  class: "security",
  fields: {
    mode: { kind: "enum", values: GITHUB_MODES },
    previousMode: { kind: "enum", values: GITHUB_MODES },
    cause: { kind: "enum", values: ["admin_switch", "failed_delivery", "given_up_delivery"] },
  },
});

/**
 * An admin stored the webhook secret of the install's GitHub App, with the
 * confirmation step (tracker-mirrors: GitHub and Jira each run in webhook mode
 * or polling mode; activity-log: Which actions are security events): a change
 * of the integration. It says whether it replaced a stored secret, and never
 * holds the secret; its provenance names the admin.
 */
export const githubWebhookSecretStored = defineEventType({
  type: "github.webhook_secret_stored",
  class: "security",
  fields: {
    replaced: { kind: "boolean" },
  },
});

/**
 * An admin uploaded a new private key for the install's GitHub App, with the
 * confirmation step, and GitHub accepted it (self-host-install: A rotated App
 * key can be uploaded; activity-log: Which actions are security events). It
 * never holds the key; its provenance names the admin.
 */
export const githubPrivateKeyUploaded = defineEventType({
  type: "github.private_key_uploaded",
  class: "security",
  fields: {},
});

/**
 * A member approved an agent client on the consent screen, with the
 * confirmation step (agent-access: Approving an agent client uses the
 * confirmation step; activity-log: Which actions are security events): the
 * grant that lets the client act for them. It names the member, the client, by
 * Tiehall's own record of it, and the grant; its provenance names the member,
 * whose web session confirmed it. Approving the same client again names the
 * same grant.
 */
export const agentClientApproved = defineEventType({
  type: "agent_client.approved",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    clientId: { kind: "id", of: "client" },
    grantId: { kind: "id", of: "grant" },
  },
});

/**
 * An agent grant was revoked, so its client acts for the member no more
 * (agent-access: Users list and revoke their own agent grants and tokens;
 * activity-log: Which actions are security events). It names the member whose
 * grant it was, the client and the grant.
 */
export const agentGrantRevoked = defineEventType({
  type: "agent_grant.revoked",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    clientId: { kind: "id", of: "client" },
    grantId: { kind: "id", of: "grant" },
  },
});

/**
 * A user created a personal access token in the web UI, with the confirmation
 * step (agent-access: Personal access tokens are scoped, expiring and created
 * in the web UI; activity-log: Which actions are security events). It names
 * the user it acts for and the token, never its value, its label or its hash;
 * its provenance names the user, whose web session confirmed it.
 */
export const personalAccessTokenCreated = defineEventType({
  type: "personal_access_token.created",
  class: "security",
  fields: {
    userId: { kind: "id", of: "user" },
    tokenId: { kind: "id", of: "token" },
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
  memberJoined,
  inviteCreated,
  inviteRevoked,
  signInPolicyChanged,
  writeBudgetChanged,
  trustStateReconciled,
  activityLogExported,
  signInCompleted,
  signInRefused,
  setupCompleted,
  githubInstallationConnected,
  githubInstallationDisconnected,
  githubModeChanged,
  githubWebhookSecretStored,
  githubPrivateKeyUploaded,
  agentClientApproved,
  agentGrantRevoked,
  personalAccessTokenCreated,
];
