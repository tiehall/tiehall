import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import {
  createInstallGitHub,
  createInvitesRoute,
  createMembersRoute,
  createSignInPolicyRoute,
  createTeamsRoute,
  csrfTokenFor,
  INVITES_PATH,
  MEMBERS_PATH,
  SIGN_IN_POLICY_PATH,
  TEAMS_PATH,
  type Caller,
  type WebSessionCaller,
} from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// The pages of the web UI for members, invites, teams and the sign-in policy
// (teams-and-roles: What admins and members may do; teams-and-roles: Invites
// by GitHub username; teams-and-roles: Revoking an invite; teams-and-roles:
// Changing a member's role; teams-and-roles: Removing a member;
// teams-and-roles: Teams; teams-and-roles: Bot users; sign-in: The sign-in
// policy). Every member sees the members list, ordered by GitHub login, with
// each member's role, teams and bot mark (design.md, Decisions: D45 (3)); an
// admin also finds there the links to the review pages that change a role or
// remove a member, and the forms that set and clear the bot flag. The
// invites, teams and sign-in policy pages are an admin's: an admin invites a
// GitHub username through a form that looks it up on GitHub at once and then
// through the invite's review page, which names the account it found
// (github-layer-hardening: design.md, Decisions this change rests on:
// D50 (12)), and revokes a waiting invite with a form; creates, renames and
// rekeys teams and adds people to
// them and removes them with forms; and changes the sign-in policy through
// its review page. The reads behind the pages are admin actions too, offered
// on no agent surface. Every page runs its reads through execute() in a
// read-only transaction; every form's POST passes the web UI's write checks
// and runs through execute(), so a member gets 403 and changes nothing; a
// browser without a session is sent to sign in first (D28 #66).

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
let bot: string;
let lee: string;
/** The GitHub accounts the stub knows, by login. */
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  // The GitHub the invite form looks usernames up on: the install's App, installed on acme and connected.
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-dev", "sam-dev", "zoe-dev", "kim-dev"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
  bot = await addUser(install.owner, { role: "member", login: "acme-ci-bot" });
  lee = await addUser(install.owner, { role: "member", login: "lee-dev", githubAccountId: accounts.get("lee-dev")!.id });
  await install.owner.query("UPDATE users SET bot = true WHERE id = $1", [bot]);
  await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'OPS', 'Operations' FROM orgs");
  await install.owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT org_id, id, $1 FROM teams WHERE key = 'OPS'", [bot]);
  await install.owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT org_id, id, $1 FROM teams WHERE key = 'OPS'", [dana.userId]);
});

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

const options = (session: WebSessionCaller | undefined) => ({
  execute: install.execute,
  session: async () => session,
  url: URL_OF_INSTALL,
  secret: () => install.authSecret,
  logger: install.logger,
});
const membersPage = (session: WebSessionCaller | undefined) => createMembersRoute(options(session));
const invitesPage = (session: WebSessionCaller | undefined) => createInvitesRoute(options(session));
const teamsPage = (session: WebSessionCaller | undefined) => createTeamsRoute(options(session));
const policyPage = (session: WebSessionCaller | undefined) => createSignInPolicyRoute(options(session));

const get = (route: (request: Request) => Promise<Response>, path: string) => route(new Request(`${URL_OF_INSTALL}${path}`));

/** A form posted from a page of the install, with the session's CSRF token unless the test gives another, and the headers a browser sends. */
function post(
  route: (request: Request) => Promise<Response>,
  path: string,
  session: WebSessionCaller,
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
): Promise<Response> {
  return route(
    new Request(`${URL_OF_INSTALL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ csrf: csrfTokenFor(install.authSecret, session.sessionId), ...fields }).toString(),
    }),
  );
}

/** A page's text with the characters escaped in HTML, such as an apostrophe, written as themselves. */
const unescaped = (html: string) => html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

/** The review page's link for an action and its input, as a page writes it into an href. */
const reviewLink = (commandId: string, input: unknown) => `/confirm/${commandId}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** An admin's personal access token, on the REST surface. */
const adminsToken = (): Caller => ({ kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:read", "requests:write"], surface: "api" });

describe("the members page", () => {
  it("shows every member, ordered by login, with their role, teams and bot mark, and no admin control to a member", async () => {
    const answer = await get(membersPage(dana), MEMBERS_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    // Each member's login, marked when a bot, their role as a tag and their teams as keys (web-ui: The page shell and its navigation).
    const rows = [
      ...html.matchAll(/<tr>\s*<td class="cell-member">[\s\S]*?<span class="member-login">([^<]*)<\/span><\/td>\s*<td data-label="Role"><span class="chip tag[^"]*">([^<]*)<\/span><\/td>\s*<td data-label="Teams">([\s\S]*?)<\/td>/g),
    ].map(([, login, role, teams = ""]) => ({ login, role, teams: [...teams.matchAll(/<a class="key" href="\/[A-Z0-9]+">([A-Z0-9]+)<\/a>/g)].map(([, key]) => key).join(", ") }));
    expect(rows).toEqual([
      { login: "acme-ci-bot (a bot user)", role: "member", teams: "OPS" },
      { login: "ada", role: "admin", teams: "" },
      { login: "dana", role: "member", teams: "OPS" },
      { login: "lee-dev", role: "member", teams: "" },
    ]);
    // The page's own content: the shell holds the member's sign-out form (web-ui: The page shell and its navigation).
    const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
    expect(main).not.toContain("/confirm/");
    expect(main).not.toContain("<form");
    expect(html).not.toContain("/confirm/");
  });

  it("gives an admin the review pages that change a role or remove a member, and the forms for the bot flag", async () => {
    const html = await (await get(membersPage(ada), MEMBERS_PATH)).text();
    expect(html).toContain(`href="${reviewLink("members.change_role", { userId: lee, role: "admin" })}">Make lee-dev an admin</a>`);
    expect(html).toContain(`href="${reviewLink("members.change_role", { userId: ada.userId, role: "member" })}">Make ada a member</a>`);
    expect(html).toContain(`href="${reviewLink("members.remove", { userId: lee })}">Remove lee-dev from the install</a>`);
    expect(html).toContain("Mark lee-dev as a bot");
    expect(html).toContain("Clear the bot mark of acme-ci-bot");
    expect(html).toContain(`href="${INVITES_PATH}"`);
  });

  it("sends a browser without a session to sign in first", async () => {
    const answer = await get(membersPage(undefined), MEMBERS_PATH);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(MEMBERS_PATH)}`);
  });

  it("lets an admin set and clear the bot flag with a form that passes the write checks", async () => {
    const set = await post(membersPage(ada), MEMBERS_PATH, ada, { action: "set_bot_flag", userId: lee, bot: "true" });
    expect(set.status).toBe(303);
    expect(set.headers.get("location")).toBe(MEMBERS_PATH);
    expect((await install.owner.query("SELECT bot FROM users WHERE id = $1", [lee])).rows).toEqual([{ bot: true }]);
    await expect((await get(membersPage(dana), MEMBERS_PATH)).text()).resolves.toContain("lee-dev (a bot user)");
    expect((await post(membersPage(ada), MEMBERS_PATH, ada, { action: "set_bot_flag", userId: lee, bot: "false" })).status).toBe(303);
    expect((await install.owner.query("SELECT bot FROM users WHERE id = $1", [lee])).rows).toEqual([{ bot: false }]);
  });

  it("refuses a member's bot flag form, and one from another origin or without the CSRF token, with 403, and changes nothing", async () => {
    expect((await post(membersPage(dana), MEMBERS_PATH, dana, { action: "set_bot_flag", userId: dana.userId, bot: "true" })).status).toBe(403);
    expect(
      (await post(membersPage(ada), MEMBERS_PATH, ada, { action: "set_bot_flag", userId: lee, bot: "true" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await post(membersPage(ada), MEMBERS_PATH, ada, { action: "set_bot_flag", userId: lee, bot: "true", csrf: "" })).status).toBe(403);
    expect((await install.owner.query("SELECT bot FROM users WHERE id IN ($1, $2)", [dana.userId, lee])).rows).toEqual([{ bot: false }, { bot: false }]);
  });

  it("answers a form that names no action of the page with 404", async () => {
    expect((await post(membersPage(ada), MEMBERS_PATH, ada, { action: "remove", userId: lee })).status).toBe(404);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM members WHERE user_id = $1", [lee])).rows).toEqual([{ n: 1 }]);
  });
});

describe("the invites page", () => {
  beforeEach(async () => {
    await install.owner.query("DELETE FROM invites");
  });

  /** An invite written as the owner, for a GitHub account, with its state. */
  async function addInvite(login: string, state: "waiting" | "expired" | "revoked" | "accepted", role = "member"): Promise<string> {
    const { rows } = await install.owner.query<{ id: string }>(
      `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at, accepted_at, accepted_by, revoked_at, revoked_by)
       SELECT id, $1, $2, $3, $4,
              CASE WHEN $5 = 'expired' THEN now() - interval '8 days' ELSE now() END,
              CASE WHEN $5 = 'expired' THEN now() - interval '1 day' ELSE now() + interval '7 days' END,
              CASE WHEN $5 = 'accepted' THEN now() END, CASE WHEN $5 = 'accepted' THEN $6::uuid END,
              CASE WHEN $5 = 'revoked' THEN now() END, CASE WHEN $5 = 'revoked' THEN $4::uuid END
         FROM orgs RETURNING id`,
      [Math.floor(Math.random() * 2 ** 40) + 1, login, role, ada.userId, state, lee],
    );
    return rows[0]!.id;
  }

  it("lists only the invites that wait to be accepted, each with a form that revokes it", async () => {
    const waiting = await addInvite("sam-dev", "waiting", "admin");
    await addInvite("tom-dev", "expired");
    await addInvite("uma-dev", "revoked");
    await addInvite("lee-dev", "accepted");
    const answer = await get(invitesPage(ada), INVITES_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    expect(html).toMatch(/sam-dev, invited as admin, valid until \d{4}-\d{2}-\d{2}T/);
    expect(html).toContain(`name="invite" value="${waiting}"`);
    expect(html).toContain("Revoke the invite for sam-dev");
    for (const login of ["tom-dev", "uma-dev", "lee-dev"]) expect(html).not.toContain(login);
  });

  it("says when no invite waits, and offers the form that invites a GitHub username", async () => {
    const html = await (await get(invitesPage(ada), INVITES_PATH)).text();
    expect(html).toContain("No invite is waiting to be accepted.");
    expect(html).toContain('<form method="get" action="/admin/invites">');
    expect(html).toContain('name="login"');
    expect(html).toContain('<option value="member" selected>member</option>');
  });

  it("looks the invite form's username up at once and sends the admin to the invite's review page, with the account's numeric id and the role as its input, and creates nothing", async () => {
    const from = stub.received.length;
    const answer = await get(invitesPage(ada), `${INVITES_PATH}?login=sam-dev&role=admin`);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(reviewLink("invites.create", { accountId: accounts.get("sam-dev")!.id, role: "admin" }));
    expect(stub.received.slice(from).map(({ method, path }) => `${method} ${path}`)).toContain("GET /users/sam-dev");
    const trimmed = await get(invitesPage(ada), `${INVITES_PATH}?login=%20zoe-dev%20`);
    expect(trimmed.headers.get("location")).toBe(reviewLink("invites.create", { accountId: accounts.get("zoe-dev")!.id, role: "member" }));
    expect((await install.owner.query("SELECT count(*)::int AS n FROM invites")).rows).toEqual([{ n: 0 }]);
  });

  // Each refusal of the form comes before any review page, as the error model's problem, and creates nothing.
  describe("refuses the invite form, with no review page", () => {
    async function refusal(answer: Response): Promise<{ status: number; type: unknown }> {
      expect(answer.headers.get("location")).toBeNull();
      return { status: answer.status, type: ((await answer.json()) as { type?: unknown }).type };
    }

    /** Makes the install reach GitHub through this fetch, with the client's timeout lowered when a test gives one, until the run ends. */
    async function reachingGitHubThrough(through: typeof fetch, run: () => Promise<void>, timeoutMs?: number): Promise<void> {
      install.useGitHub(
        createInstallGitHub({
          database: install.db,
          secrets: () => install.box,
          apiUrl: stub.apiUrl,
          fetch: through,
          logger: install.logger,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
      try {
        await run();
      } finally {
        install.useGitHub(harness.github);
      }
    }

    const lookUpOfKim = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input)).pathname === "/users/kim-dev";

    afterEach(async () => {
      expect((await install.owner.query("SELECT count(*)::int AS n FROM invites")).rows).toEqual([{ n: 0 }]);
    });

    it("with 404 for a login that names no GitHub account, or an organization", async () => {
      for (const login of ["no-such-user-9f2", "acme"]) {
        expect(await refusal(await get(invitesPage(ada), `${INVITES_PATH}?login=${login}`))).toEqual({
          status: 404,
          type: "https://tiehall.com/problems/record-not-found",
        });
      }
    });

    it("with 409 for an account whose person is already a member", async () => {
      expect(await refusal(await get(invitesPage(ada), `${INVITES_PATH}?login=lee-dev`))).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    });

    it("with 409 when no installation of the App is connected", async () => {
      const { rows } = await install.owner.query<{ org_id: string; installation_id: string; connected_at: Date }>(
        "DELETE FROM github_connected_installations RETURNING org_id, installation_id, connected_at",
      );
      try {
        expect(await refusal(await get(invitesPage(ada), `${INVITES_PATH}?login=kim-dev`))).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
      } finally {
        for (const row of rows) {
          await install.owner.query("INSERT INTO github_connected_installations (org_id, installation_id, connected_at) VALUES ($1, $2, $3)", [
            row.org_id,
            row.installation_id,
            row.connected_at,
          ]);
        }
      }
    });

    it("with 502 integration-unavailable when GitHub answers the look-up with 500", async () => {
      await reachingGitHubThrough(
        async (input, init) => (lookUpOfKim(input) ? new Response('{"message":"Server Error"}', { status: 500, headers: { "content-type": "application/json" } }) : fetch(input, init)),
        async () => {
          expect(await refusal(await get(invitesPage(ada), `${INVITES_PATH}?login=kim-dev`))).toEqual({
            status: 502,
            type: "https://tiehall.com/problems/integration-unavailable",
          });
        },
      );
    });

    // Not answering within the client's timeout, lowered here from its 10 seconds to 1.
    it("with 502 integration-unavailable when GitHub does not answer the look-up in time", async () => {
      await reachingGitHubThrough(
        async (input, init) => {
          if (!lookUpOfKim(input)) return fetch(input, init);
          const signal = init?.signal;
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(fetch(input, init)), 10_000);
            signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
          });
        },
        async () => {
          expect(await refusal(await get(invitesPage(ada), `${INVITES_PATH}?login=kim-dev`))).toEqual({
            status: 502,
            type: "https://tiehall.com/problems/integration-unavailable",
          });
        },
        1_000,
      );
    });
  });

  it("lets an admin revoke a waiting invite, with no confirmation step, as a security event", async () => {
    const waiting = await addInvite("sam-dev", "waiting");
    const before = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    const answer = await post(invitesPage(ada), INVITES_PATH, ada, { action: "revoke", invite: waiting });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(INVITES_PATH);
    expect((await install.owner.query("SELECT revoked_by FROM invites WHERE id = $1", [waiting])).rows).toEqual([{ revoked_by: ada.userId }]);
    const { rows } = await install.owner.query("SELECT type, class FROM events WHERE number > $1", [before]);
    expect(rows).toEqual([{ type: "invite.revoked", class: "security" }]);
    await expect((await get(invitesPage(ada), INVITES_PATH)).text()).resolves.toContain("No invite is waiting to be accepted.");
  });

  it("is an admin's: a member gets 403 on the page, its invite form and its revoke form, and a browser without a session signs in first", async () => {
    const waiting = await addInvite("sam-dev", "waiting");
    const refusedPage = await get(invitesPage(dana), INVITES_PATH);
    expect(refusedPage.status).toBe(403);
    // The refusal shows no invite.
    expect(await refusedPage.text()).not.toContain("sam-dev");
    expect((await get(invitesPage(dana), `${INVITES_PATH}?login=zoe-dev&role=admin`)).status).toBe(403);
    expect((await post(invitesPage(dana), INVITES_PATH, dana, { action: "revoke", invite: waiting })).status).toBe(403);
    expect((await post(invitesPage(ada), INVITES_PATH, ada, { action: "revoke", invite: waiting }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await install.owner.query("SELECT revoked_at FROM invites WHERE id = $1", [waiting])).rows).toEqual([{ revoked_at: null }]);
    const anonymous = await get(invitesPage(undefined), INVITES_PATH);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(INVITES_PATH)}`);
  });

  it("looks the username up through invites.find_account, which only admins run and no agent surface offers", async () => {
    expect(await install.web(ada).read("invites.find_account", { login: "zoe-dev" })).toEqual({
      ok: true,
      output: { account: { id: accounts.get("zoe-dev")!.id, githubLogin: "zoe-dev" } },
    });
    expect(await install.web(dana).read("invites.find_account", { login: "zoe-dev" })).toMatchObject({ ok: false, problem: { status: 403 } });
    await expect(install.execute("invites.find_account", adminsToken(), { login: "zoe-dev" })).rejects.toMatchObject({ status: 404 });
  });

  it("reads the waiting invites through invites.list, which only admins run and no agent surface offers", async () => {
    await addInvite("sam-dev", "waiting");
    const listed = await install.web(ada).read<{ invites: { githubLogin: string; role: string }[] }>("invites.list", {});
    expect(listed).toMatchObject({ ok: true, output: { invites: [{ githubLogin: "sam-dev", role: "member" }] } });
    expect(await install.web(dana).read("invites.list", {})).toMatchObject({ ok: false, problem: { status: 403 } });
    await expect(install.execute("invites.list", adminsToken(), {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("the teams page", () => {
  const teamIdOf = async (key: string) => (await install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = $1", [key])).rows[0]!.id;
  const membersOf = async (key: string) =>
    (
      await install.owner.query<{ user_id: string }>(
        "SELECT m.user_id FROM team_members m JOIN teams t ON t.org_id = m.org_id AND t.id = m.team_id WHERE t.key = $1 ORDER BY m.user_id",
        [key],
      )
    ).rows.map(({ user_id }) => user_id);

  it("shows each team with its key, name, old keys and people, and the forms that change them", async () => {
    await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'WEB', 'Web' FROM orgs");
    await install.owner.query("INSERT INTO team_key_aliases (org_id, key, team_id) SELECT org_id, 'FE', id FROM teams WHERE key = 'WEB'");
    const answer = await get(teamsPage(ada), TEAMS_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await answer.text();
    expect(html.indexOf("<h2>OPS: Operations</h2>")).toBeGreaterThan(-1);
    expect(html.indexOf("<h2>WEB: Web</h2>")).toBeGreaterThan(html.indexOf("<h2>OPS: Operations</h2>"));
    expect(html).toContain("Its earlier keys, which still lead to it: FE.");
    expect(html).toContain("acme-ci-bot (a bot user)");
    expect(html).toContain("Remove dana from OPS");
    expect(html).toContain("Nobody belongs to WEB.");
    expect(html).toContain("Add a member to WEB");
    expect(html).toContain("Rename WEB");
    expect(html).toContain("Change the key of WEB");
    expect(html).toContain("Create the team");
  });

  it("lets an admin create a team, rename it, change its key, add a member and remove them, each with a form", async () => {
    const created = await post(teamsPage(ada), TEAMS_PATH, ada, { action: "create", key: "MOB", name: "Mobile" });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe(TEAMS_PATH);
    const mob = await teamIdOf("MOB");
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "rename", teamId: mob, name: "Mobile apps" })).status).toBe(303);
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "change_key", teamId: mob, key: "APP" })).status).toBe(303);
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "add_member", teamId: mob, userId: lee })).status).toBe(303);
    expect((await install.owner.query("SELECT key, name FROM teams WHERE id = $1", [mob])).rows).toEqual([{ key: "APP", name: "Mobile apps" }]);
    expect(await membersOf("APP")).toEqual([lee]);
    const html = await (await get(teamsPage(ada), TEAMS_PATH)).text();
    expect(html).toContain("<h2>APP: Mobile apps</h2>");
    expect(html).toContain("Its earlier keys, which still lead to it: MOB.");
    expect(html).toContain("Remove lee-dev from APP");
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "remove_member", teamId: mob, userId: lee })).status).toBe(303);
    expect(await membersOf("APP")).toEqual([]);
  });

  it("answers a key in another form with 400 and a taken key with 409, and changes nothing", async () => {
    const before = (await install.owner.query("SELECT key, name FROM teams ORDER BY key")).rows;
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "create", key: "fe", name: "Frontend" })).status).toBe(400);
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "create", key: "OPS", name: "Another" })).status).toBe(409);
    expect((await install.owner.query("SELECT key, name FROM teams ORDER BY key")).rows).toEqual(before);
  });

  it("is an admin's: a member gets 403 on the page and its forms, and a browser without a session signs in first", async () => {
    const refusedPage = await get(teamsPage(dana), TEAMS_PATH);
    expect(refusedPage.status).toBe(403);
    // The refusal shows no team, and none of a team's earlier keys or people.
    const refusal = await refusedPage.text();
    for (const shown of ["OPS", "Operations", "acme-ci-bot"]) expect(refusal).not.toContain(shown);
    const refused = await post(teamsPage(dana), TEAMS_PATH, dana, { action: "create", key: "DNA", name: "Dana's" });
    expect(refused.status).toBe(403);
    expect((await post(teamsPage(dana), TEAMS_PATH, dana, { action: "add_member", teamId: await teamIdOf("OPS"), userId: dana.userId })).status).toBe(403);
    expect((await post(teamsPage(ada), TEAMS_PATH, ada, { action: "create", key: "DNA", name: "Dana's" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await install.owner.query("SELECT count(*)::int AS n FROM teams WHERE key = 'DNA'")).rows).toEqual([{ n: 0 }]);
    const anonymous = await get(teamsPage(undefined), TEAMS_PATH);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(TEAMS_PATH)}`);
  });

  it("reads the teams through teams.list, which only admins run and no agent surface offers", async () => {
    const listed = await install.web(ada).read<{ teams: { key: string; members: { login: string; kind: string; bot: boolean }[] }[] }>("teams.list", {});
    expect(listed.ok).toBe(true);
    const ops = listed.ok ? listed.output.teams.find(({ key }) => key === "OPS") : undefined;
    expect(ops?.members.map(({ login, kind, bot: flagged }) => ({ login, kind, bot: flagged }))).toEqual([
      { login: "acme-ci-bot", kind: "human", bot: true },
      { login: "dana", kind: "human", bot: false },
    ]);
    expect(await install.web(dana).read("teams.list", {})).toMatchObject({ ok: false, problem: { status: 403 } });
    await expect(install.execute("teams.list", adminsToken(), {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("the sign-in policy page", () => {
  it("shows the policy in force and links to the review page that changes it", async () => {
    await install.owner.query("DELETE FROM install_settings");
    const answer = await get(policyPage(ada), SIGN_IN_POLICY_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = unescaped(await answer.text());
    expect(html).toContain("The install's sign-in policy is organization members and invited people.");
    expect(html).toContain(`href="${reviewLink("settings.set_sign_in_policy", { policy: "invited_only" })}">Change the policy to invited people only</a>`);

    expect((await install.confirm(ada, "settings.set_sign_in_policy", { policy: "invited_only" })).status).toBe(200);
    const changed = unescaped(await (await get(policyPage(ada), SIGN_IN_POLICY_PATH)).text());
    expect(changed).toContain("The install's sign-in policy is invited people only.");
    expect(changed).toContain(
      `href="${reviewLink("settings.set_sign_in_policy", { policy: "organization_members_and_invited" })}">Change the policy to organization members and invited people</a>`,
    );
  });

  it("is an admin's: a member gets 403, and a browser without a session signs in first", async () => {
    const refusedPage = await get(policyPage(dana), SIGN_IN_POLICY_PATH);
    expect(refusedPage.status).toBe(403);
    // The refusal shows no policy.
    const refusal = unescaped(await refusedPage.text());
    for (const shown of ["organization members and invited", "invited people only", "organization_members_and_invited", "invited_only"]) expect(refusal).not.toContain(shown);
    const anonymous = await get(policyPage(undefined), SIGN_IN_POLICY_PATH);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(SIGN_IN_POLICY_PATH)}`);
  });

  it("reads the policy through settings.get_sign_in_policy, which only admins run and no agent surface offers", async () => {
    await install.owner.query("DELETE FROM install_settings");
    expect(await install.web(ada).read("settings.get_sign_in_policy", {})).toEqual({ ok: true, output: { policy: "organization_members_and_invited" } });
    expect(await install.web(dana).read("settings.get_sign_in_policy", {})).toMatchObject({ ok: false, problem: { status: 403 } });
    await expect(install.execute("settings.get_sign_in_policy", adminsToken(), {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("every page", () => {
  it.each([
    ["the members page", MEMBERS_PATH, membersPage],
    ["the invites page", INVITES_PATH, invitesPage],
    ["the teams page", TEAMS_PATH, teamsPage],
    ["the sign-in policy page", SIGN_IN_POLICY_PATH, policyPage],
  ] as const)("%s changes nothing on a GET, and answers another method with 404", async (_name, path, pageOf) => {
    const before = (await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows;
    expect((await get(pageOf(ada), path)).status).toBe(200);
    expect((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows).toEqual(before);
    expect((await pageOf(ada)(new Request(`${URL_OF_INSTALL}${path}`, { method: "DELETE" }))).status).toBe(404);
  });
});
