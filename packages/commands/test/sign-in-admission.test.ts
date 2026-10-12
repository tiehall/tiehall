import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubInstallation, type StubUser } from "@tiehall/testing/github";
import { readInstallations, SIGN_IN_GITHUB_UNAVAILABLE, SIGN_IN_REFUSED } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInAttempt, type SignInHarness } from "./support/sign-in.ts";

// Who may sign in (sign-in: Who may sign in; design.md, Self-hosting
// decisions: S5). A person may sign in when GitHub reports, through an
// installation of the install's App that an admin connected, that their
// account is a member of that installation's organization; when they hold a
// valid invite; or when their user is already a member of the install. An
// installation nobody connected admits no one, an outside collaborator is not
// a member of the organization, and a lookup that fails or goes through a
// suspended installation admits no one through that organization. Anyone else
// is refused with 403, told to ask an admin for an invite, and gets no
// session, no user and no membership; a refusal and a sign-in are each a
// security event, and so is a join, together with the membership it makes.
//
// Invites are created by an admin with the confirmation step (task 9.5); here
// they are written as the database holds them.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let acme: StubInstallation;
let anaUserId: string;
let pia: string;
/** The stub's accounts, by login. */
const accounts = new Map<string, StubUser>();
/** What the install's logger wrote. */
const logLines: string[] = [];

beforeAll(async () => {
  install = await startTestInstall({ log: (line) => logLines.push(line) });
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-acme", "lou-acme", "ana-k", "kim-labs", "sam-outside", "jo-contracts", "jan-contracts", "joy-contracts"]) {
    accounts.set(login, stub.addUser({ login, email: `${login}@example.com` }));
  }
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin", "lee-acme": "member", "lou-acme": "member", "ana-k": "member" } });
  stub.addOrg({ login: "acme-labs", members: { "omar-acme": "admin", "kim-labs": "member" } });
  stub.addRepo("acme/web");
  harness = await startSignIn(install, stub);
  // A public App installs on another organization than its owner.
  stub.updateApp(harness.app, { public: true });
  acme = await stub.install(harness.app, { account: "acme" });
  await stub.install(harness.app, { account: "acme-labs" });
  await harness.connect("acme");
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function counts(login: string): Promise<{ users: number; members: number; sessions: number }> {
  const { rows } = await install.owner.query<{ users: string; members: string; sessions: string }>(
    `SELECT (SELECT count(*) FROM users WHERE github_login = $1) AS users,
            (SELECT count(*) FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1) AS members,
            (SELECT count(*) FROM web_sessions s JOIN users u ON u.org_id = s.org_id AND u.id = s.user_id WHERE u.github_login = $1) AS sessions`,
    [login],
  );
  const row = rows[0]!;
  return { users: Number(row.users), members: Number(row.members), sessions: Number(row.sessions) };
}

async function roleOf(login: string): Promise<string | undefined> {
  const { rows } = await install.owner.query<{ role: string }>(
    "SELECT m.role FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1",
    [login],
  );
  return rows[0]?.role;
}

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
}

async function eventsSince(number: number): Promise<{ type: string; data: Record<string, unknown>; actor_kind: string; actor_user_id: string | null }[]> {
  const { rows } = await install.owner.query("SELECT type, data, actor_kind, actor_user_id FROM events WHERE number > $1 ORDER BY number", [number]);
  return rows;
}

/** An invite as the database holds one: for this GitHub account, created by Pia, this many days ago. */
async function invite(login: string, options: { role?: "admin" | "member"; daysAgo?: number; revoked?: boolean } = {}): Promise<string> {
  const githubAccountId = accounts.get(login)?.id;
  const { rows } = await install.owner.query<{ id: string }>(
    `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at, revoked_at, revoked_by)
       SELECT id, $1, $2, $3, $4, now() - make_interval(days => $5), now() - make_interval(days => $5) + interval '7 days',
              CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $4::uuid END
         FROM orgs RETURNING id`,
    [githubAccountId, login, options.role ?? "member", pia, options.daysAgo ?? 0, options.revoked ?? false],
  );
  return rows[0]!.id;
}

async function expectRefused(attempt: SignInAttempt, login: string): Promise<void> {
  expect(attempt.response.status).toBe(403);
  const problem = (await attempt.response.json()) as { type: string; detail: string };
  expect(problem.type).toBe("https://tiehall.com/problems/sign-in-refused");
  expect(problem.detail).toBe(SIGN_IN_REFUSED);
  expect(await harness.sessionOf(attempt.jar)).toBeUndefined();
  expect(await counts(login)).toEqual({ users: 0, members: 0, sessions: 0 });
}

describe("a member of a connected installation's organization", () => {
  it("signs in, joins the install as a member, and the join and the sign-in are security events", async () => {
    const from = await lastEvent();
    const { response, jar } = await harness.signIn("lee-acme");
    expect(response.status).toBe(302);
    const session = await harness.sessionOf(jar);
    expect(session).toMatchObject({ kind: "web_session" });
    expect(await roleOf("lee-acme")).toBe("member");
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["member.joined", "sign_in.completed"]);
    expect(events[0]).toEqual({
      type: "member.joined",
      data: { userId: session?.userId, role: "member", through: "organization" },
      actor_kind: "web_session",
      actor_user_id: session?.userId,
    });
  });

  it("is kept as seen in that organization, so leaving it later can end their access", async () => {
    const { rows } = await install.owner.query(
      `SELECT mo.github_organization_id FROM member_organizations mo JOIN users u ON u.org_id = mo.org_id AND u.id = mo.user_id
        WHERE u.github_login = 'lee-acme'`,
    );
    expect(rows).toEqual([{ github_organization_id: String(acme.account.id) }]);
  });

  it("signs in again as the same member, and joins no second time", async () => {
    const from = await lastEvent();
    expect((await harness.signIn("lee-acme")).response.status).toBe(302);
    expect((await eventsSince(from)).map(({ type }) => type)).toEqual(["sign_in.completed"]);
    expect(await counts("lee-acme")).toMatchObject({ users: 1, members: 1 });
  });
});

describe("an organization whose installation nobody connected", () => {
  it("admits no one: its member gets 403 with the text to ask an admin for an invite, and no session, user or membership", async () => {
    const from = await lastEvent();
    await expectRefused(await harness.signIn("kim-labs"), "kim-labs");
    expect((await eventsSince(from)).map(({ type }) => type)).toEqual(["sign_in.refused"]);
  });
});

describe("an outside collaborator", () => {
  it("who is not a member of the connected organization gets 403", async () => {
    await expectRefused(await harness.signIn("sam-outside"), "sam-outside");
  });
});

// sign-in: Who may sign in; public-api: One error model for Tiehall's own refusals (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (7); Technical decisions: T3). When a person could be admitted only
// through an organization's membership, and GitHub fails the look-up through a working connected installation, with an
// error it gives no answer of its own for or no answer within 10 seconds, while no other look-up reports the account a
// member, the sign-in is answered 502 integration-unavailable: it admits no one, creates no session, user or
// membership, records no refused sign-in, and Tiehall logs a warning.
describe("a failed membership lookup", () => {
  /** A sign-in service whose calls to GitHub's member endpoints of these organizations fail as `fail` answers them. */
  function failingLookups(organizations: RegExp, fail: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, timeoutMs?: number) {
    return startSignIn(install, stub, {
      sameAppAs: harness,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (organizations.test(url.pathname)) return fail(input, init);
        return fetch(input, init);
      },
    });
  }

  async function expectUnavailable(attempt: SignInAttempt, login: string, from: number): Promise<void> {
    expect(attempt.response.status).toBe(502);
    expect(attempt.response.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await attempt.response.json()) as { type: string; detail: string };
    expect(problem.type).toBe("https://tiehall.com/problems/integration-unavailable");
    expect(problem.detail).toBe(SIGN_IN_GITHUB_UNAVAILABLE);
    expect(await harness.sessionOf(attempt.jar)).toBeUndefined();
    expect(await counts(login)).toEqual({ users: 0, members: 0, sessions: 0 });
    // No refusal happened: the activity log gains nothing, and no record of the account is kept.
    expect(await eventsSince(from)).toEqual([]);
    const { rows } = await install.owner.query("SELECT 1 FROM sign_in_refusals WHERE github_login = $1", [login]);
    expect(rows).toEqual([]);
  }

  it("answers 502 integration-unavailable when GitHub answers the lookup with 500, admits no one, records no refused sign-in and logs a warning", async () => {
    const failing = await failingLookups(/^\/orgs\/[^/]+\/members/, async () => new Response('{"message":"Server Error"}', { status: 500 }));
    const from = await lastEvent();
    const logged = logLines.length;
    await expectUnavailable(await failing.signIn("lou-acme"), "lou-acme", from);
    expect(logLines.slice(logged).map((line) => JSON.parse(line) as { level: string; msg: string })).toContainEqual(
      expect.objectContaining({ level: "warn", msg: expect.stringContaining("GitHub could not be reached") }),
    );
  });

  it("answers 502 when GitHub does not answer the lookup within the client's wait, lowered here", async () => {
    const failing = await failingLookups(
      /^\/orgs\/[^/]+\/members/,
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          // GitHub never answers: the client's wait gives up.
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      300,
    );
    const from = await lastEvent();
    await expectUnavailable(await failing.signIn("lou-acme"), "lou-acme", from);
  });

  it("admits a member that another connected installation reports, though the lookup through one fails", async () => {
    // Max is a member of acme and of acme-ops, whose installation an admin connected too; GitHub fails acme's lookup.
    accounts.set("max-ops", stub.addUser({ login: "max-ops" }));
    stub.addOrg({ login: "acme-ops", members: { "omar-acme": "admin", "max-ops": "member" } });
    await stub.addMember("acme", "max-ops");
    const ops = await stub.install(harness.app, { account: "acme-ops" });
    const connected = await harness.connect("acme-ops");
    try {
      const failing = await failingLookups(/^\/orgs\/acme\/members/, async () => new Response('{"message":"Server Error"}', { status: 500 }));
      const { response, jar } = await failing.signIn("max-ops");
      expect(response.status).toBe(302);
      expect(await failing.sessionOf(jar)).toMatchObject({ kind: "web_session" });
      expect(await roleOf("max-ops")).toBe("member");
      const { rows } = await install.owner.query(
        `SELECT mo.github_organization_id FROM member_organizations mo JOIN users u ON u.org_id = mo.org_id AND u.id = mo.user_id
          WHERE u.github_login = 'max-ops'`,
      );
      expect(rows).toEqual([{ github_organization_id: String(ops.account.id) }]);
    } finally {
      await install.owner.query("DELETE FROM github_connected_installations WHERE installation_id = $1", [connected["acme-ops"]]);
    }
  });
});

describe("GitHub's answers for an organization's public members only", () => {
  it("admit no one through an organization whose login another organization took, who is a public member of that one", async () => {
    // acme was renamed, another organization took the login, and the listing has not read the new one yet. GitHub
    // answers the installation's token about the new acme as it does a requester that may not see its members: by
    // the public members only, of whom mallory is one.
    const mallory = stub.addUser({ login: "mallory" });
    accounts.set("mallory", mallory);
    stub.setMemberAnswers("documented");
    stub.renameOrg("acme", "acme-inc");
    stub.addOrg({ login: "acme", members: { mallory: "member" } });
    stub.setMembershipPublic("acme", "mallory", true);
    const reading = await startSignIn(install, stub, { sameAppAs: harness });
    const from = stub.received.length;
    await expectRefused(await reading.signIn("mallory"), "mallory");
    expect(stub.received.slice(from).map(({ method, path }) => `${method} ${path}`)).toContain("GET /users/acme");
  });
});

describe("a suspended installation", () => {
  it("admits no new member, while a member who joined through it earlier still signs in", async () => {
    // Ana joined through acme earlier.
    anaUserId = await addUser(install.owner, { login: "ana-k", githubAccountId: accounts.get("ana-k")!.id });
    await install.owner.query("INSERT INTO member_organizations (org_id, user_id, github_organization_id) SELECT id, $1, $2 FROM orgs", [
      anaUserId,
      acme.account.id,
    ]);
    await stub.suspend(acme);
    try {
      // GitHub refuses the suspended installation's token, before Tiehall's listing knows it is suspended.
      await expectRefused(await harness.signIn("lou-acme"), "lou-acme");
      // Once the listing knows, Tiehall asks GitHub nothing through it.
      await readInstallations({ database: install.db, app: (await harness.github.app())! });
      const from = stub.received.length;
      await expectRefused(await harness.signIn("lou-acme"), "lou-acme");
      const throughAcme = stub.received
        .slice(from)
        .filter(({ path }) => path.startsWith("/orgs/acme/") || path === `/app/installations/${acme.id}/access_tokens`)
        .map(({ method, path }) => `${method} ${path}`);
      expect(throughAcme).toEqual([]);
      const { response, jar } = await harness.signIn("ana-k");
      expect(response.status).toBe(302);
      expect(await harness.sessionOf(jar)).toMatchObject({ userId: anaUserId });
    } finally {
      await stub.unsuspend(acme);
      await readInstallations({ database: install.db, app: (await harness.github.app())! });
    }
  });
});

describe("an invite", () => {
  it("that is valid admits a person outside every organization, with the invite's role, and the sign-in accepts it", async () => {
    const id = await invite("jo-contracts", { role: "admin", daysAgo: 2 });
    const from = await lastEvent();
    const { response, jar } = await harness.signIn("jo-contracts");
    expect(response.status).toBe(302);
    const session = await harness.sessionOf(jar);
    expect(await roleOf("jo-contracts")).toBe("admin");
    const { rows } = await install.owner.query("SELECT accepted_by FROM invites WHERE id = $1 AND accepted_at IS NOT NULL", [id]);
    expect(rows).toEqual([{ accepted_by: session?.userId }]);
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["member.joined", "sign_in.completed"]);
    expect(events[0]?.data).toEqual({ userId: session?.userId, role: "admin", through: "invite", inviteId: id });
  });

  it("that has expired gets 403, and gives no membership", async () => {
    await invite("jan-contracts", { daysAgo: 8 });
    await expectRefused(await harness.signIn("jan-contracts"), "jan-contracts");
  });

  it("that was revoked gets 403, and gives no membership", async () => {
    await invite("joy-contracts", { revoked: true });
    await expectRefused(await harness.signIn("joy-contracts"), "joy-contracts");
  });
});
