import { defineEventType, type EventType } from "./events.ts";
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

/** A message posted in a request's thread. It names the message; readers fetch its text through a read. */
export const messagePosted = defineEventType({
  type: "request.message_posted",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    messageId: { kind: "id", of: "message" },
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

export const EVENT_TYPES: readonly EventType[] = [
  requestOpened,
  requestClaimed,
  requestStarted,
  requestReleased,
  messagePosted,
  memberRoleChanged,
  memberRemoved,
];
