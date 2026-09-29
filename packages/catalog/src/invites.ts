import { z } from "zod";
import { defineCommand } from "./command.ts";
import { GITHUB_LOGIN, role } from "./schemas.ts";

// Invites (teams-and-roles: Invites by GitHub username; teams-and-roles: What
// admins and members may do; agent-safety: Actions that need the confirmation
// step). An admin invites a person by their GitHub username, in the web UI,
// with the confirmation step, so no agent surface offers it. The invite form
// looks the username up first (invites.find_account), and the invite it leads
// to names the GitHub account by its numeric id, the one the review page
// shows, so the invite is bound to that account (github-layer-hardening:
// design.md, Decisions this change rests on: D50 (12)); it names a role,
// `member` unless it names `admin`, and expires 7 days after it is created. An admin revokes
// a pending invite in the web UI without the confirmation step, because that
// only narrows who may join (teams-and-roles: Revoking an invite). The web
// UI's invites page lists the invites that wait to be accepted, for admins
// only, so they can revoke one.

/** An invite as the operations return it: the GitHub login it was created for, the role it gives and when it expires. */
export const invite = z.object({
  id: z.uuid(),
  /**
   * The GitHub login the invite was created for, as GitHub gave it then: a
   * GitHub account's, not a Tiehall user's, and the invite follows the
   * account whatever its login becomes.
   */
  githubLogin: z.string().regex(GITHUB_LOGIN),
  role,
  expiresAt: z.iso.datetime(),
});

/** A GitHub account's numeric id, which never changes, whatever its login becomes. */
const githubAccountId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const findInviteAccount = defineCommand({
  id: "invites.find_account",
  summary:
    "Look up which GitHub account a username names, before an invite for it is reviewed: a person's account, whose person is not a member of the install yet.",
  input: z.object({ login: z.string().regex(GITHUB_LOGIN).meta({ description: "The GitHub username of the person to invite." }) }),
  output: z.object({
    account: z.object({
      id: githubAccountId,
      /** The account's login now, as GitHub gives it: a GitHub account's, not a Tiehall user's. */
      githubLogin: z.string().regex(GITHUB_LOGIN),
    }),
  }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const createInvite = defineCommand({
  id: "invites.create",
  summary: "Invite a person to the install by their GitHub account's numeric id, with the role member unless the invite names admin.",
  input: z.object({
    accountId: githubAccountId.meta({ description: "The numeric id of the GitHub account to invite, as the invite form's look-up of its username found it." }),
    role: role.default("member"),
  }),
  output: z.object({ invite }),
  scopes: [],
  commitment: false,
  confirm: true,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const revokeInvite = defineCommand({
  id: "invites.revoke",
  summary: "Revoke a pending invite, so it admits no one.",
  input: z.object({ invite: z.uuid() }),
  output: z.object({ invite: z.uuid(), revoked: z.literal(true) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const listInvites = defineCommand({
  id: "invites.list",
  summary: "List the invites that wait to be accepted: neither accepted, revoked nor expired.",
  input: z.object({}),
  output: z.object({ invites: z.array(invite) }),
  scopes: [],
  commitment: false,
  confirm: false,
  admin: "members",
  surfaces: [],
  stability: "beta",
});

export const INVITE_COMMANDS = [findInviteAccount, createInvite, revokeInvite, listInvites];
