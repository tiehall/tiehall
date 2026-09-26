// The role matrix (teams-and-roles: Two roles, admin and member;
// teams-and-roles: What admins and members may do; teams-and-roles: The role
// bounds every caller acting for a user; design.md, Decisions this change rests
// on: D28 #4; design.md, Self-hosting decisions: S6). Each member of the install
// holds exactly one of two roles, and there is no other, such as owner. Only
// admins take the admin actions, one per item of the spec's list; execute()
// consults the matrix for every caller that acts for a user, through a web
// session or a token, so no session or token acts beyond its user's role.
// Every other action is open to every member, or is decided by the person's
// part in the record it acts on, such as belonging to a request's target team,
// being on its requester side or holding its claim, or belonging to the team
// whose record it is. A part never comes from the role: the admin role stands
// in for no part in a request, and a team's members act on its records whatever
// their role. The install always keeps at least one admin.

export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Whether a value names one of the two roles. */
export function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

/**
 * The actions only admins may take, one per item of the spec's list
 * (teams-and-roles: What admins and members may do). They run only in the web
 * UI, on no agent surface (agent-surfaces: Admin actions and trust changes are
 * on no agent surface).
 */
export const ADMIN_ACTIONS = [
  /** Create and revoke invites, change members' roles and remove members. */
  "members",
  /** Create teams, change a team's name or key, add people to teams and remove them, and set a team's intake notes and required fields. */
  "teams",
  /** Set the sign-in policy. */
  "sign_in_policy",
  /** Connect and configure integrations: GitHub installations, the GitHub App's private key, the Jira connection and team mappings. */
  "integrations",
  /** Register and unregister APIs. */
  "apis",
  /** Turn personal access tokens on or off, set their longest lifetime, and set the daily write budget. */
  "agent_access",
  /** Set and clear a user's bot flag. */
  "bot_flag",
  /** Confirm a contract-change fan-out to more than 10 consumer teams. */
  "fan_out",
  /** View and export the activity log. */
  "activity_log",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** The admin actions each role allows. */
const ROLE_MATRIX: Readonly<Record<Role, readonly AdminAction[]>> = {
  admin: ADMIN_ACTIONS,
  member: [],
};

/** Whether a role allows an admin action. */
export function roleAllows(role: Role, action: AdminAction): boolean {
  return ROLE_MATRIX[role].includes(action);
}

/**
 * The parts a person can hold in a record, which decide what they may do there
 * whatever their role: in a request, belonging to its target team, being on
 * its requester side (the requesting user or a member of the requesting team)
 * and holding its claim; in a team's own records, such as the APIs it
 * consumes, belonging to that team.
 */
export const PARTS = ["target_team", "requester_side", "claimant", "team_member"] as const;
export type Part = (typeof PARTS)[number];

/** Who may take an action: only admins, every member, or whoever holds one of these parts, whatever their role. */
export type Access =
  | { kind: "admin"; action: AdminAction }
  | { kind: "member" }
  | { kind: "part"; parts: readonly Part[] };

/** A member acting on a record: their role, and the parts they hold in that record. */
export interface Actor {
  role: Role;
  parts: readonly Part[];
}

/** Whether a member may take an action. */
export function allows(actor: Actor, access: Access): boolean {
  switch (access.kind) {
    case "admin":
      return roleAllows(actor.role, access.action);
    case "member":
      return true;
    case "part":
      return access.parts.some((part) => actor.parts.includes(part));
  }
}

/** A change to who is a member, or in which role. */
export type MembershipChange = { kind: "role"; userId: string; role: Role } | { kind: "removal"; userId: string };

/**
 * Whether a change would leave the install without an admin, given who the
 * admins are now; such a change is refused with 409 and changes nothing.
 */
export function leavesNoAdmin(admins: readonly string[], change: MembershipChange): boolean {
  const after = new Set(admins);
  if (change.kind === "role" && change.role === "admin") after.add(change.userId);
  else after.delete(change.userId);
  return after.size === 0;
}
