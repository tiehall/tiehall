import {
  addTeamMember,
  changeMemberRole,
  changeTeamKey,
  createInvite,
  createTeam,
  findInviteAccount,
  getSignInPolicy,
  listInvites,
  listMembers,
  listTeams,
  removeMember,
  removeTeamMember,
  renameTeam,
  revokeInvite,
  setBotFlag,
  setSignInPolicy,
  type invite,
  type listedMember,
  type listedTeam,
} from "@tiehall/catalog";
import { Refusal, SIGN_IN_POLICIES, signInPolicyText, type SignInPolicy } from "@tiehall/core";
import type { z } from "zod";
import { ACTIVITY_LOG_PATH } from "./activity-log-route.ts";
import { CONFIRM_PATH } from "./confirm-route.ts";
import { GITHUB_ADMIN_PATH } from "./github-admin-route.ts";
import { escapeHtml, htmlPage } from "./html.ts";
import { INVITE_LIFETIME_DAYS } from "./invites.ts";
import { userName } from "./members.ts";
import { createPageRoute, htmlAnswer, link, postForm, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The pages of the web UI for members, invites, teams and the sign-in policy
// (teams-and-roles: What admins and members may do; teams-and-roles: Invites
// by GitHub username; teams-and-roles: Revoking an invite; teams-and-roles:
// Changing a member's role; teams-and-roles: Removing a member;
// teams-and-roles: Teams; teams-and-roles: Bot users; sign-in: The sign-in
// policy; design.md, Where the specs leave room: the admin UI's layout).
// - /members shows every member the install's members, ordered by GitHub
//   login, with their role, the keys of their teams and their bot mark
//   (design.md, Decisions: D45 (3)). An admin also finds, for each member, a
//   link to the review page that makes them an admin or a member, a link to
//   the review page that removes them, and a form that sets or clears their
//   bot flag, which needs no confirmation step.
// - /admin/invites is an admin's: a form that names a GitHub username and a
//   role looks the username up on GitHub at once, refusing a login that names
//   no person's account (404) or a member's (409), and leads to the review
//   page of an invite for the account it names, by its numeric id, where the
//   invite is created with the confirmation step (github-layer-hardening:
//   design.md, Decisions this change rests on: D50 (12)); each invite that
//   waits to be accepted has a form that revokes it, with no confirmation step.
// - /admin/teams is an admin's: forms that create a team, rename it, change
//   its key, and add a member of the install to it or remove them. None of
//   these needs the confirmation step (agent-safety: Actions that need the
//   confirmation step).
// - /admin/sign-in-policy is an admin's: the policy in force, and a link to
//   the review page that changes it, with the confirmation step.
// Every read and write runs through execute() as the signed-in session (see
// web-pages.ts), so a member who opens an admin page, or posts one of its
// forms, gets 403 and changes nothing, whatever the page shows. The admin
// pages link to one another and to the GitHub page and the activity log.

/** Where the members list lives; every member may open it. */
export const MEMBERS_PATH = "/members";
/** Where an admin invites people and revokes invites. */
export const INVITES_PATH = "/admin/invites";
/** Where an admin manages teams. */
export const TEAMS_PATH = "/admin/teams";
/** Where an admin sees and changes the sign-in policy. */
export const SIGN_IN_POLICY_PATH = "/admin/sign-in-policy";

type ListedMember = z.output<typeof listedMember>;
type ListedTeam = z.output<typeof listedTeam>;
type Invite = z.output<typeof invite>;

/** The links between the admin pages, shown to admins. */
function adminNav(): string {
  const pages: [string, string][] = [
    [MEMBERS_PATH, "Members"],
    [INVITES_PATH, "Invites"],
    [TEAMS_PATH, "Teams"],
    [SIGN_IN_POLICY_PATH, "Sign-in policy"],
    [GITHUB_ADMIN_PATH, "GitHub"],
    [ACTIVITY_LOG_PATH, "Activity log"],
  ];
  return `      <nav>${pages.map(([href, text]) => link(href, text)).join(" · ")}</nav>`;
}

/** The review page of an action that needs the confirmation step, for its exact input. */
function reviewPath(commandId: string, input: unknown): string {
  return `${CONFIRM_PATH}${commandId}?input=${encodeURIComponent(JSON.stringify(input))}`;
}

/** A field that must name a value; a missing one reaches the operation as an empty string, which its schema refuses with 400. */
function field(form: URLSearchParams, name: string): string {
  return form.get(name) ?? "";
}

// The members page.

export function createMembersRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: MEMBERS_PATH,
    name: "members",
    async get(_query, { read, caller, csrf }) {
      const { members } = await read<{ members: ListedMember[] }>(listMembers.id, {});
      const admin = members.find(({ id }) => id === caller.userId)?.role === "admin";
      return htmlAnswer(membersPage(members, admin ? csrf : undefined));
    },
    async post(form, { write }) {
      if (form.get("action") !== "set_bot_flag") throw new Refusal("route-not-found", "The members page offers no such action.");
      const bot = form.get("bot");
      await write(setBotFlag.id, { userId: field(form, "userId"), bot: bot === "true" ? true : bot === "false" ? false : bot });
      return seeOther(MEMBERS_PATH);
    },
  });
}

/** An admin's controls for one member: the review pages for their role and their removal, and the bot flag's form. */
function memberControls(member: ListedMember, csrf: string): string {
  const other = member.role === "admin" ? "member" : "admin";
  // A control names the member as every other place does, marked when they are a bot (teams-and-roles: Bot users).
  const name = userName(member);
  return [
    `          <td>`,
    `            <p>${link(reviewPath(changeMemberRole.id, { userId: member.id, role: other }), `Make ${name} ${other === "admin" ? "an admin" : "a member"}`)}</p>`,
    `            <p>${link(reviewPath(removeMember.id, { userId: member.id }), `Remove ${name} from the install`)}</p>`,
    postForm(
      MEMBERS_PATH,
      { action: "set_bot_flag", userId: member.id, bot: member.bot ? "false" : "true" },
      csrf,
      member.bot ? `Clear the bot mark of ${name}` : `Mark ${name} as a bot`,
      "            ",
    ),
    `          </td>`,
  ].join("\n");
}

/** The members list; with the CSRF token, an admin's, with their controls. */
function membersPage(members: readonly ListedMember[], adminCsrf: string | undefined): string {
  const rows = members.map((member) =>
    [
      "        <tr>",
      `          <td>${escapeHtml(userName(member))}</td>`,
      `          <td>${escapeHtml(member.role)}</td>`,
      `          <td>${escapeHtml(member.teams.join(", "))}</td>`,
      ...(adminCsrf === undefined ? [] : [memberControls(member, adminCsrf)]),
      "        </tr>",
    ].join("\n"),
  );
  return htmlPage(
    "Members",
    [
      "      <h1>Members</h1>",
      ...(adminCsrf === undefined ? [] : [adminNav()]),
      "      <p>Every member of the install, by GitHub login, with their role and the keys of the teams they belong to.</p>",
      ...(adminCsrf === undefined
        ? []
        : [
            `      <p>${link(INVITES_PATH, "Invite a person")} by their GitHub username. Changing a role and removing a member each need a confirmation; marking a bot does not.</p>`,
          ]),
      "      <table>",
      `        <thead><tr><th>Member</th><th>Role</th><th>Teams</th>${adminCsrf === undefined ? "" : "<th>Actions</th>"}</tr></thead>`,
      "        <tbody>",
      ...rows,
      "        </tbody>",
      "      </table>",
    ].join("\n"),
  );
}

// The invites page.

export function createInvitesRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: INVITES_PATH,
    name: "invites",
    async get(query, { read, csrf }) {
      // An admin's page: the read refuses a member with 403 before anything else.
      const { invites } = await read<{ invites: Invite[] }>(listInvites.id, {});
      // The invite form looks the username up at once, and leads to the review page of an invite for the account it
      // names, by its numeric id, which creates it with the confirmation step.
      const login = query.get("login")?.trim();
      if (login !== undefined && login !== "") {
        const { account } = await read<{ account: { id: number } }>(findInviteAccount.id, { login });
        return seeOther(reviewPath(createInvite.id, { accountId: account.id, role: query.get("role") ?? "member" }));
      }
      return htmlAnswer(invitesPage(invites, csrf));
    },
    async post(form, { write }) {
      if (form.get("action") !== "revoke") throw new Refusal("route-not-found", "The invites page offers no such action.");
      await write(revokeInvite.id, { invite: field(form, "invite") });
      return seeOther(INVITES_PATH);
    },
  });
}

function invitesPage(invites: readonly Invite[], csrf: string): string {
  const waiting = invites.map((invite) =>
    [
      "        <li>",
      `          <p>${escapeHtml(`${invite.githubLogin}, invited as ${invite.role}, valid until ${invite.expiresAt}.`)}</p>`,
      postForm(INVITES_PATH, { action: "revoke", invite: invite.id }, csrf, `Revoke the invite for ${invite.githubLogin}`, "          "),
      "        </li>",
    ].join("\n"),
  );
  return htmlPage(
    "Invites",
    [
      "      <h1>Invites</h1>",
      adminNav(),
      "      <h2>Invite a person</h2>",
      `      <p>An invite names a GitHub username and a role. Tiehall looks the username up on GitHub first, and the review page names the account it found; when you confirm, the invite is bound to that GitHub account, whatever its login becomes. The person joins by signing in with that account within ${INVITE_LIFETIME_DAYS} days; no email is sent.</p>`,
      `      <form method="get" action="${INVITES_PATH}">`,
      '        <p><label for="invite-login">GitHub username</label> <input type="text" id="invite-login" name="login" required></p>',
      '        <p><label for="invite-role">Role</label> <select id="invite-role" name="role"><option value="member" selected>member</option><option value="admin">admin</option></select></p>',
      '        <button type="submit">Review the invite</button>',
      "      </form>",
      "      <h2>Invites waiting to be accepted</h2>",
      "      <p>Revoking an invite needs no confirmation: a revoked invite admits no one.</p>",
      waiting.length === 0 ? "      <p>No invite is waiting to be accepted.</p>" : `      <ul>\n${waiting.join("\n")}\n      </ul>`,
    ].join("\n"),
  );
}

// The teams page.

/** The operation each of the teams page's forms runs, and its input from the form's fields. */
const TEAM_ACTIONS: Readonly<Record<string, { commandId: string; input: (form: URLSearchParams) => Record<string, string> }>> = {
  create: { commandId: createTeam.id, input: (form) => ({ key: field(form, "key"), name: field(form, "name") }) },
  rename: { commandId: renameTeam.id, input: (form) => ({ teamId: field(form, "teamId"), name: field(form, "name") }) },
  change_key: { commandId: changeTeamKey.id, input: (form) => ({ teamId: field(form, "teamId"), key: field(form, "key") }) },
  add_member: { commandId: addTeamMember.id, input: (form) => ({ teamId: field(form, "teamId"), userId: field(form, "userId") }) },
  remove_member: { commandId: removeTeamMember.id, input: (form) => ({ teamId: field(form, "teamId"), userId: field(form, "userId") }) },
};

export function createTeamsRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: TEAMS_PATH,
    name: "teams",
    async get(_query, { read, csrf }) {
      // An admin's page: the teams' read refuses a member with 403 before anything else.
      const { teams } = await read<{ teams: ListedTeam[] }>(listTeams.id, {});
      const { members } = await read<{ members: ListedMember[] }>(listMembers.id, {});
      return htmlAnswer(teamsPage(teams, members, csrf));
    },
    async post(form, { write }) {
      const action = Object.hasOwn(TEAM_ACTIONS, form.get("action") ?? "") ? TEAM_ACTIONS[form.get("action") ?? ""] : undefined;
      if (action === undefined) throw new Refusal("route-not-found", "The teams page offers no such action.");
      await write(action.commandId, action.input(form));
      return seeOther(TEAMS_PATH);
    },
  });
}

/** A form with one labelled control, hidden fields and a button, on the teams page. */
function labelledForm(fields: Readonly<Record<string, string>>, csrf: string, id: string, label: string, control: string, button: string): string {
  return [
    `      <form method="post" action="${TEAMS_PATH}">`,
    ...Object.entries(fields).map(([name, value]) => `        <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`),
    `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    `        <p><label for="${escapeHtml(id)}">${escapeHtml(label)}</label> ${control} <button type="submit">${escapeHtml(button)}</button></p>`,
    "      </form>",
  ].join("\n");
}

/** One team: its people, and the forms that add people, rename it and change its key. */
function teamSection(team: ListedTeam, members: readonly ListedMember[], csrf: string): string {
  const inTeam = new Set(team.members.map(({ id }) => id));
  const candidates = members.filter(({ id }) => !inTeam.has(id));
  const people = team.members.map((member) =>
    [
      "        <li>",
      `          <p>${escapeHtml(userName(member))}</p>`,
      postForm(TEAMS_PATH, { action: "remove_member", teamId: team.id, userId: member.id }, csrf, `Remove ${userName(member)} from ${team.key}`, "          "),
      "        </li>",
    ].join("\n"),
  );
  const options = candidates.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(userName(member))}</option>`).join("");
  return [
    `      <h2>${escapeHtml(`${team.key}: ${team.name}`)}</h2>`,
    ...(team.aliases.length === 0 ? [] : [`      <p>${escapeHtml(`Its earlier keys, which still lead to it: ${team.aliases.join(", ")}.`)}</p>`]),
    people.length === 0 ? `      <p>${escapeHtml(`Nobody belongs to ${team.key}.`)}</p>` : `      <ul>\n${people.join("\n")}\n      </ul>`,
    candidates.length === 0
      ? `      <p>${escapeHtml(`Every member of the install belongs to ${team.key}.`)}</p>`
      : labelledForm(
          { action: "add_member", teamId: team.id },
          csrf,
          `add-${team.id}`,
          `Add a member to ${team.key}`,
          `<select id="add-${escapeHtml(team.id)}" name="userId">${options}</select>`,
          `Add to ${team.key}`,
        ),
    labelledForm(
      { action: "rename", teamId: team.id },
      csrf,
      `name-${team.id}`,
      `New name for ${team.key}`,
      `<input type="text" id="name-${escapeHtml(team.id)}" name="name" value="${escapeHtml(team.name)}" required>`,
      `Rename ${team.key}`,
    ),
    labelledForm(
      { action: "change_key", teamId: team.id },
      csrf,
      `key-${team.id}`,
      `New key for ${team.key}`,
      `<input type="text" id="key-${escapeHtml(team.id)}" name="key" required>`,
      `Change the key of ${team.key}`,
    ),
  ].join("\n");
}

function teamsPage(teams: readonly ListedTeam[], members: readonly ListedMember[], csrf: string): string {
  return htmlPage(
    "Teams",
    [
      "      <h1>Teams</h1>",
      adminNav(),
      "      <p>Requests are addressed to teams. A person can belong to several teams, and a team may have nobody in it. A key has 2 to 10 uppercase letters and digits and starts with a letter; a team keeps its earlier keys, so no other team can take them.</p>",
      "      <h2>Create a team</h2>",
      `      <form method="post" action="${TEAMS_PATH}">`,
      '        <input type="hidden" name="action" value="create">',
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      '        <p><label for="team-key">Key</label> <input type="text" id="team-key" name="key" required></p>',
      '        <p><label for="team-name">Name</label> <input type="text" id="team-name" name="name" required></p>',
      '        <button type="submit">Create the team</button>',
      "      </form>",
      ...(teams.length === 0 ? ["      <p>The install has no team yet.</p>"] : teams.map((team) => teamSection(team, members, csrf))),
    ].join("\n"),
  );
}

// The sign-in policy page.

/** What a sign-in policy means, in Tiehall's own words. */
function policyMeaning(policy: SignInPolicy): string {
  return policy === "organization_members_and_invited"
    ? "Members of the GitHub organizations whose installations are connected can sign in and join as members, and so can people an admin invited."
    : "Only people an admin invited can join. Membership of a connected GitHub organization admits nobody who is not a member yet; existing members keep signing in.";
}

export function createSignInPolicyRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: SIGN_IN_POLICY_PATH,
    name: "sign-in policy",
    async get(_query, { read }) {
      const { policy } = await read<{ policy: SignInPolicy }>(getSignInPolicy.id, {});
      const others = SIGN_IN_POLICIES.filter((other) => other !== policy);
      return htmlAnswer(
        htmlPage(
          "Sign-in policy",
          [
            "      <h1>Sign-in policy</h1>",
            adminNav(),
            `      <p>${escapeHtml(`The install's sign-in policy is ${signInPolicyText(policy)}.`)}</p>`,
            `      <p>${escapeHtml(policyMeaning(policy))}</p>`,
            ...others.map(
              (other) => `      <p>${link(reviewPath(setSignInPolicy.id, { policy: other }), `Change the policy to ${signInPolicyText(other)}`)}, with a confirmation. No member is removed.</p>`,
            ),
          ].join("\n"),
        ),
      );
    },
  });
}
