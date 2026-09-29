import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { createInstallGitHub, type Caller, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Invites by GitHub username (teams-and-roles: Invites by GitHub username;
// sign-in: Who may sign in; activity-log: Which actions are security events;
// agent-safety: Actions that need the confirmation step; design.md,
// Self-hosting decisions: S5 and S7). An admin invites a person by their
// GitHub username, in the web UI, with the confirmation step. When the invite
// is created, Tiehall resolves the username to the GitHub account's numeric
// id through GitHub's API and binds the invite to that account, so it follows
// a login rename and never passes to a new holder of the old login; a username
// that names no account gets 404 and creates no invite. The invite names a
// role, `member` unless it names `admin`, expires 7 days after it is created,
// and needs no email: the invitee accepts it by signing in with that account
// while it is valid. Each invite is a security event.
//
// Revoking an invite (teams-and-roles: Revoking an invite): an admin revokes a
// pending invite in the web UI, without the confirmation step, because it only
// narrows who may join; a revoked invite admits no one, and the revocation is
// a security event. A member's attempt gets 403 and changes nothing.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let dana: WebSessionCaller;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-dev", "sam-dev", "tom-dev", "uma-dev", "vic-dev", "wes-dev", "xia-dev", "ned-dev", "oli-dev"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  dana = { kind: "web_session", userId: await addUser(install.owner, { role: "member", login: "dana" }), sessionId: randomUUID() };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

let lastEvent: number;
beforeEach(async () => {
  lastEvent = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
});

interface InviteRow {
  id: string;
  github_account_id: string;
  github_login: string;
  role: string;
  created_by: string;
  lifetime: string;
  accepted_at: Date | null;
}

async function invitesFor(login: string): Promise<InviteRow[]> {
  const { rows } = await install.owner.query<InviteRow>(
    `SELECT id, github_account_id, github_login, role, created_by, (expires_at - created_at)::text AS lifetime, accepted_at
       FROM invites WHERE lower(github_login) = lower($1) ORDER BY created_at`,
    [login],
  );
  return rows;
}

async function eventsSince(): Promise<{ type: string; class: string; data: Record<string, unknown>; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query("SELECT type, class, data, actor_user_id FROM events WHERE number > $1 ORDER BY number", [lastEvent]);
  return rows;
}

async function problemOf(answer: Response): Promise<{ status: number; type: unknown }> {
  const body = (await answer.text()).trim();
  return { status: answer.status, type: body.startsWith("{") ? (JSON.parse(body) as { type?: unknown }).type : undefined };
}

async function roleOf(login: string): Promise<string | undefined> {
  const { rows } = await install.owner.query<{ role: string }>(
    "SELECT m.role FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1",
    [login],
  );
  return rows[0]?.role;
}

describe("an invite an admin confirms", () => {
  it("is bound to the GitHub account the username names, with the role member, expires 7 days after it is created, and is a security event", async () => {
    const answer = await install.confirm(ada, "invites.create", { login: "lee-dev" });
    expect(answer.status).toBe(200);
    const [created] = await invitesFor("lee-dev");
    expect(created).toMatchObject({
      github_account_id: String(accounts.get("lee-dev")!.id),
      github_login: "lee-dev",
      role: "member",
      created_by: ada.userId,
      lifetime: "7 days",
      accepted_at: null,
    });
    expect(await eventsSince()).toEqual([
      { type: "invite.created", class: "security", data: { inviteId: created!.id, role: "member" }, actor_user_id: ada.userId },
    ]);
  });

  it("that names the role admin makes the invitee an admin when they sign in, with no email sent", async () => {
    expect((await install.confirm(ada, "invites.create", { login: "sam-dev", role: "admin" })).status).toBe(200);
    expect((await invitesFor("sam-dev"))[0]).toMatchObject({ role: "admin" });
    expect(install.sentJobs.filter(({ queue }) => queue.includes("email"))).toEqual([]);
    expect((await harness.signIn("sam-dev")).response.status).toBe(302);
    expect(await roleOf("sam-dev")).toBe("admin");
  });

  it("shows on its review page, in Tiehall's words, whom it invites and with which role", async () => {
    const input = encodeURIComponent(JSON.stringify({ login: "tom-dev", role: "admin" }));
    const page = await install.confirmRoute(ada)(new Request(`${URL_OF_INSTALL}/confirm/invites.create?input=${input}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Invite the GitHub account tom-dev to the install, with the role admin.");
    expect(html).toContain("expires 7 days after it is created");
    expect(await invitesFor("tom-dev")).toEqual([]);
  });
});

describe("a username", () => {
  it("that names no GitHub account gets 404 and an RFC 9457 problem, and creates no invite", async () => {
    const answer = await install.confirm(ada, "invites.create", { login: "no-such-user-9f2" });
    expect(await problemOf(answer)).toEqual({ status: 404, type: "https://tiehall.com/problems/record-not-found" });
    expect(await invitesFor("no-such-user-9f2")).toEqual([]);
    expect(await eventsSince()).toEqual([]);
  });

  it("that names a GitHub organization, not a person's account, gets 404 and creates no invite", async () => {
    const answer = await install.confirm(ada, "invites.create", { login: "acme" });
    expect((await problemOf(answer)).status).toBe(404);
    expect(await invitesFor("acme")).toEqual([]);
  });

  it("is looked up with an installation token of the install's App", async () => {
    const from = stub.received.length;
    expect((await install.confirm(ada, "invites.create", { login: "uma-dev" })).status).toBe(200);
    const lookups = stub.received.slice(from).filter(({ path }) => path === "/users/uma-dev");
    expect(lookups.map(({ token }) => token?.kind)).toEqual(["installation"]);
  });
});

describe("the invite", () => {
  it("follows a login rename: Lee, renamed to lee-k, still joins through it", async () => {
    stub.renameUser("lee-dev", "lee-k");
    const { response } = await harness.signIn("lee-k");
    expect(response.status).toBe(302);
    expect(await roleOf("lee-k")).toBe("member");
    expect((await invitesFor("lee-dev"))[0]?.accepted_at).not.toBeNull();
  });

  it("gives a new holder of the old login nothing, and stays valid for its account until it expires", async () => {
    expect((await install.confirm(ada, "invites.create", { login: "vic-dev" })).status).toBe(200);
    stub.renameUser("vic-dev", "vic-k");
    stub.addUser({ login: "vic-dev" });
    expect((await harness.signIn("vic-dev")).response.status).toBe(403);
    expect((await invitesFor("vic-dev"))[0]).toMatchObject({ github_account_id: String(accounts.get("vic-dev")!.id), accepted_at: null });
    expect((await harness.signIn("vic-k")).response.status).toBe(302);
    expect(await roleOf("vic-k")).toBe("member");
  });
});

describe("creating an invite", () => {
  it("without the confirmation step gets 403, and creates no invite", async () => {
    const result = await install.web(ada).write("invites.create", { login: "zed-dev" }, install.fromThePage(ada));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await invitesFor("zed-dev")).toEqual([]);
  });

  it("by a member gets 403, and creates no invite", async () => {
    stub.addUser({ login: "zoe-dev" });
    const answer = await install.confirm(dana, "invites.create", { login: "zoe-dev" });
    expect((await problemOf(answer)).status).toBe(403);
    expect(await invitesFor("zoe-dev")).toEqual([]);
  });

  it("that names the role owner gets 400", async () => {
    const answer = await install.confirm(ada, "invites.create", { login: "zoe-dev", role: "owner" });
    expect(await problemOf(answer)).toEqual({ status: 400, type: "https://tiehall.com/problems/invalid-input" });
  });

  it("for a person who is already a member gets 409, and creates no invite", async () => {
    const answer = await install.confirm(ada, "invites.create", { login: "sam-dev" });
    expect(await problemOf(answer)).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    expect(await invitesFor("sam-dev")).toHaveLength(1);
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    await expect(install.execute("invites.create", token, { login: "zoe-dev" })).rejects.toMatchObject({ status: 404 });
  });
});

// GitHub is asked outside any transaction (design.md, Technical decisions: T3 and T16): the username is looked
// up after the call is authorized and before its write transaction opens and its confirmation is used, so a
// slow GitHub holds no connection in a transaction and no lock, and a GitHub that fails leaves the confirmation
// unused, so the admin can post the same review page again.
describe("creating an invite while GitHub answers slowly or fails", () => {
  /** Makes the install reach GitHub through this fetch until the test ends. */
  async function reachingGitHubThrough(through: typeof fetch, run: () => Promise<void>): Promise<void> {
    install.useGitHub(createInstallGitHub({ database: install.db, secrets: () => install.box, apiUrl: stub.apiUrl, fetch: through, logger: install.logger }));
    try {
      await run();
    } finally {
      install.useGitHub(harness.github);
    }
  }

  /** The other sessions of this database that are in a transaction and waiting for their client, such as for GitHub. */
  async function idleInTransaction(): Promise<string[]> {
    const { rows } = await install.owner.query<{ state: string }>(
      "SELECT state FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'",
    );
    return rows.map(({ state }) => state);
  }

  it("holds no transaction open while GitHub names the account", { timeout: 30_000 }, async () => {
    let asked: () => void = () => {};
    const lookedUp = new Promise<void>((resolve) => (asked = resolve));
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    await reachingGitHubThrough(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/users/ned-dev") {
          asked();
          await released;
        }
        return fetch(input, init);
      },
      async () => {
        const creating = install.confirm(ada, "invites.create", { login: "ned-dev" });
        await lookedUp;
        let open: string[];
        try {
          open = await idleInTransaction();
        } finally {
          release();
        }
        expect(open).toEqual([]);
        expect((await creating).status).toBe(200);
      },
    );
    expect(await invitesFor("ned-dev")).toHaveLength(1);
  });

  it("that GitHub fails leaves the confirmation unused, so the same review page's form creates the invite once GitHub answers", async () => {
    let failing = true;
    await reachingGitHubThrough(
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (failing && url.pathname === "/users/oli-dev") return new Response('{"message":"Server Error"}', { status: 500 });
        return fetch(input, init);
      },
      async () => {
        const post = await install.prepareConfirmation(ada, "invites.create", { login: "oli-dev" });
        expect((await post()).status).toBeGreaterThanOrEqual(500);
        expect(await invitesFor("oli-dev")).toEqual([]);
        failing = false;
        expect((await post()).status).toBe(200);
      },
    );
    expect(await invitesFor("oli-dev")).toHaveLength(1);
  });
});

/** Creates an invite for this username as Ada, with the confirmation step; returns its id. */
async function invited(login: string): Promise<string> {
  expect((await install.confirm(ada, "invites.create", { login })).status).toBe(200);
  const [created] = await invitesFor(login);
  return created!.id;
}

function revoke(caller: WebSessionCaller, inviteId: string) {
  return install.web(caller).write("invites.revoke", { invite: inviteId }, install.fromThePage(caller));
}

describe("revoking an invite", () => {
  it("needs no confirmation step: the revoked invite admits no one, and the activity log holds a security event for the revocation", async () => {
    const inviteId = await invited("wes-dev");
    lastEvent = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    expect(await revoke(ada, inviteId)).toEqual({ ok: true, output: { invite: inviteId, revoked: true } });
    expect(await eventsSince()).toEqual([{ type: "invite.revoked", class: "security", data: { inviteId }, actor_user_id: ada.userId }]);
    const { rows } = await install.owner.query("SELECT revoked_by FROM invites WHERE id = $1 AND revoked_at IS NOT NULL", [inviteId]);
    expect(rows).toEqual([{ revoked_by: ada.userId }]);
    expect((await harness.signIn("wes-dev")).response.status).toBe(403);
    expect(await roleOf("wes-dev")).toBeUndefined();
  });

  it("again changes nothing more and records nothing more", async () => {
    const inviteId = await invited("xia-dev");
    expect(await revoke(ada, inviteId)).toMatchObject({ ok: true });
    lastEvent = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    expect(await revoke(ada, inviteId)).toEqual({ ok: true, output: { invite: inviteId, revoked: true } });
    expect(await eventsSince()).toEqual([]);
  });

  it("by a member gets 403, and the invite stays valid", async () => {
    stub.addUser({ login: "yan-dev" });
    const inviteId = await invited("yan-dev");
    expect(await revoke(dana, inviteId)).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/forbidden" } });
    expect((await harness.signIn("yan-dev")).response.status).toBe(302);
    expect(await roleOf("yan-dev")).toBe("member");
  });

  it("that an accepted invite gets 409, and changes nothing", async () => {
    const [accepted] = await invitesFor("yan-dev");
    expect(await revoke(ada, accepted!.id)).toMatchObject({ ok: false, problem: { status: 409 } });
    expect((await invitesFor("yan-dev"))[0]?.accepted_at).not.toBeNull();
  });

  it("that names no invite gets 404", async () => {
    expect(await revoke(ada, randomUUID())).toMatchObject({ ok: false, problem: { status: 404, type: "https://tiehall.com/problems/record-not-found" } });
  });

  it("from another origin gets 403, as every web UI write does", async () => {
    stub.addUser({ login: "zak-dev" });
    const inviteId = await invited("zak-dev");
    const result = await install.web(ada).write("invites.revoke", { invite: inviteId }, { ...install.fromThePage(ada), origin: "https://evil.example" });
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
    expect(await install.owner.query("SELECT 1 FROM invites WHERE id = $1 AND revoked_at IS NULL", [inviteId])).toMatchObject({ rowCount: 1 });
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    await expect(install.execute("invites.revoke", token, { invite: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
});
