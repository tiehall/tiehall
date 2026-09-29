import { memberJoined, memberRemoved, memberRoleChanged, setupCompleted, trustStateReconciled } from "./event-types.ts";
import { UUID } from "./events.ts";
import { isRole, type Role } from "./roles.ts";

// The nightly comparison of the trust state with the security events
// (activity-log: Trust-state changes are reconciled every night; design.md,
// Technical decisions: T8; design.md, Self-hosting decisions: S14). The trust
// state is who the members are, in which role, and which agent-client grants
// exist. Replayed in order, the security events record it: a role change
// records the member in the new role, a removal records that they are gone,
// and a `reconciled` event records what an earlier comparison found. The
// comparison with the install's current state gives one difference per
// member or grant whose current state the events do not record; each becomes
// a `reconciled` security event, so that a change whose event was lost, for
// example between a write the sign-in service owns and its event, still
// appears in the activity log, and the next comparison finds nothing. Each
// task that adds a security event which says who is a member, in which role,
// or which grants exist, such as a sign-in that joins a member, adds its
// event type to the replay here.

/** A member of the install, in their role. */
export interface MemberState {
  userId: string;
  role: Role;
}

/** An agent client's grant, for the user who approved it. */
export interface GrantState {
  grantId: string;
  userId: string;
}

/** Who the members are, in which role, and which grants exist. */
export interface TrustState {
  members: readonly MemberState[];
  grants: readonly GrantState[];
}

/** A security event as the replay reads it: its type and the ids and values it carries. */
export interface TrustEvent {
  type: string;
  data: Readonly<Record<string, unknown>>;
}

/** What differs between the current trust state and the recorded one, as a `reconciled` event records it. */
export type TrustDifference =
  | { subject: "member"; userId: string; present: true; role: Role }
  | { subject: "member"; userId: string; present: false }
  | { subject: "grant"; userId: string; grantId: string; present: boolean };

/** The event types the replay reads, in the order the tasks added them. */
export const TRUST_STATE_EVENT_TYPES: readonly string[] = [
  memberRoleChanged.type,
  memberRemoved.type,
  trustStateReconciled.type,
  setupCompleted.type,
  memberJoined.type,
];

function idOf(data: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

/**
 * The trust state the security events record, replayed in the order given,
 * members by user id and grants by grant id; an event that says nothing
 * well-formed is ignored.
 */
export function recordedTrustState(events: readonly TrustEvent[]): TrustState {
  const members = new Map<string, Role>();
  const grants = new Map<string, string>();
  for (const { type, data } of events) {
    const userId = idOf(data, "userId");
    if (userId === undefined) continue;
    if (type === memberRoleChanged.type) {
      if (isRole(data["role"])) members.set(userId, data["role"]);
    } else if (type === setupCompleted.type) {
      // The first admin joins with the completion of setup.
      members.set(userId, "admin");
    } else if (type === memberJoined.type) {
      // A sign-in admitted a new member, in the role their way in gave them.
      if (isRole(data["role"])) members.set(userId, data["role"]);
    } else if (type === memberRemoved.type) {
      members.delete(userId);
    } else if (type === trustStateReconciled.type) {
      if (data["subject"] === "member") {
        if (data["present"] === false) members.delete(userId);
        else if (data["present"] === true && isRole(data["role"])) members.set(userId, data["role"]);
      } else if (data["subject"] === "grant") {
        const grantId = idOf(data, "grantId");
        if (grantId === undefined) continue;
        if (data["present"] === true) grants.set(grantId, userId);
        else if (data["present"] === false) grants.delete(grantId);
      }
    }
  }
  return {
    members: [...members.keys()].sort().map((userId) => ({ userId, role: members.get(userId) as Role })),
    grants: [...grants.keys()].sort().map((grantId) => ({ grantId, userId: grants.get(grantId) as string })),
  };
}

/**
 * What the current trust state has that the recorded one does not, and the
 * other way round: members by user id, then grants by grant id.
 */
export function trustDifferences(current: TrustState, recorded: TrustState): TrustDifference[] {
  const differences: TrustDifference[] = [];
  const recordedMembers = new Map(recorded.members.map(({ userId, role }) => [userId, role]));
  const currentMembers = new Map(current.members.map(({ userId, role }) => [userId, role]));
  for (const userId of [...new Set([...recordedMembers.keys(), ...currentMembers.keys()])].sort()) {
    const role = currentMembers.get(userId);
    if (role === undefined) differences.push({ subject: "member", userId, present: false });
    else if (recordedMembers.get(userId) !== role) differences.push({ subject: "member", userId, present: true, role });
  }
  const recordedGrants = new Map(recorded.grants.map(({ grantId, userId }) => [grantId, userId]));
  const currentGrants = new Map(current.grants.map(({ grantId, userId }) => [grantId, userId]));
  for (const grantId of [...new Set([...recordedGrants.keys(), ...currentGrants.keys()])].sort()) {
    const userId = currentGrants.get(grantId);
    if (userId === undefined) differences.push({ subject: "grant", userId: recordedGrants.get(grantId) ?? "", grantId, present: false });
    else if (recordedGrants.get(grantId) !== userId) differences.push({ subject: "grant", userId, grantId, present: true });
  }
  return differences;
}
