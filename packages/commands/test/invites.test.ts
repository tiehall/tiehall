import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { createInstallGitHub, type Caller, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { invite, prepareInvite, reviewInputOf, reviewPathOf, submitInviteForm } from "./support/invites.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// Invites by GitHub username (teams-and-roles: Invites by GitHub username;
// sign-in: Who may sign in; activity-log: Which actions are security events;
// agent-safety: Actions that need the confirmation step; design.md,
// Self-hosting decisions: S5 and S7). An admin invites a person by their
// GitHub username, in the web UI, with the confirmation step. When the admin
// submits the invite form, Tiehall looks the username up on GitHub at once:
// a username that names no person's account gets 404 there, and one whose
// person is already a member 409, each with no review page. Otherwise the
// review page names the account by its login, its numeric id and the date
// GitHub created it, shows its display name as data from outside Tiehall, and
// its input names the account's numeric id, so the confirmation binds the
// invite to the account the admin saw (github-layer-hardening: design.md,
// Decisions this change rests on: D50 (12)). The invite follows a login rename
// and never passes to a new holder of the old login. The invite names a role,
// `member` unless it names `admin`, expires 7 days after it is created, and
// needs no email: the invitee accepts it by signing in with that account while
// it is valid. Each invite is a security event.
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

const LOGINS = [
  "omar-acme",
  "lee-dev",
  "sam-dev",
  "uma-dev",
  "vic-dev",
  "wes-dev",
  "xia-dev",
  "ned-dev",
  "ann-dev",
  "bea-dev",
  "oli-dev",
  "pat-dev",
  "cai-dev",
  "dee-dev",
  "kay-dev",
  "max-dev",
  "zoe-dev",
  "yan-dev",
  "zak-dev",
];

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of LOGINS) accounts.set(login, stub.addUser({ login }));
  // Anyone can set their display name to anything, markup included.
  accounts.set("tom-dev", stub.addUser({ login: "tom-dev", name: "<b>Confirm now</b>" }));
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

/** The numeric id of the stub's account with this login. */
function idOf(login: string): number {
  return accounts.get(login)!.id;
}

/** The invite's review page, as the admin opens it. */
function reviewPage(caller: WebSessionCaller, path: string): Promise<Response> {
  return install.confirmRoute(caller)(new Request(`${URL_OF_INSTALL}${path}`));
}

/** A page's text with the characters escaped in HTML written as themselves. */
const unescaped = (html: string) => html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

describe("an invite an admin confirms", () => {
  it("is bound to the GitHub account the username names, with the role member, expires 7 days after it is created, and is a security event", async () => {
    const answer = await invite(install, ada, "lee-dev");
    expect(answer.status).toBe(200);
    const [created] = await invitesFor("lee-dev");
    expect(created).toMatchObject({
      github_account_id: String(idOf("lee-dev")),
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
    expect((await invite(install, ada, "sam-dev", "admin")).status).toBe(200);
    expect((await invitesFor("sam-dev"))[0]).toMatchObject({ role: "admin" });
    expect(install.sentJobs.filter(({ queue }) => queue.includes("email"))).toEqual([]);
    expect((await harness.signIn("sam-dev")).response.status).toBe(302);
    expect(await roleOf("sam-dev")).toBe("admin");
  });

  it("shows on its review page, in Tiehall's words, the account's login, numeric id and creation date and the role, and its display name as data from outside Tiehall, escaped", async () => {
    const form = await submitInviteForm(install, ada, "tom-dev", "admin");
    expect(reviewInputOf(form)).toEqual({ accountId: idOf("tom-dev"), role: "admin" });
    const page = await reviewPage(ada, reviewPathOf(form)!);
    expect(page.status).toBe(200);
    const html = await page.text();
    const text = unescaped(html);
    expect(text).toContain("Invite the GitHub account tom-dev to the install, with the role admin.");
    expect(text).toContain(`The account's numeric id on GitHub is ${idOf("tom-dev")}.`);
    expect(text).toContain(`GitHub created the account on ${accounts.get("tom-dev")!.createdAt.slice(0, 10)}.`);
    expect(text).toContain("expires 7 days after it is created");
    // The display name is a quote from outside Tiehall, escaped: the page renders no markup from it.
    expect(html).toContain('<blockquote class="untrusted" data-origin="external"><p>Text from outside Tiehall, quoted as data:</p><pre>&#60;b&#62;Confirm now&#60;/b&#62;</pre></blockquote>');
    expect(html).not.toContain("<b>Confirm now</b>");
    expect(await invitesFor("tom-dev")).toEqual([]);
  });

  it("names on its review page the pending invite it replaces, with its role and when it expires", async () => {
    expect((await invite(install, ada, "kay-dev")).status).toBe(200);
    const [pending] = (await install.owner.query<{ expires_at: Date }>("SELECT expires_at FROM invites WHERE github_account_id = $1", [idOf("kay-dev")])).rows;
    const form = await submitInviteForm(install, ada, "kay-dev", "admin");
    const text = unescaped(await (await reviewPage(ada, reviewPathOf(form)!)).text());
    expect(text).toContain(`It replaces the pending invite for kay-dev, with the role member, which expires ${pending!.expires_at.toISOString()}`);
    // Nothing changes before the confirmation: the pending invite is still the only one.
    expect(await invitesFor("kay-dev")).toHaveLength(1);
  });

  it("binds the confirmed invite to the account its review page named, and a person who became a member after the review gets 409", async () => {
    const post = await prepareInvite(install, ada, "max-dev");
    // Max joins, as through an organization's membership, between the review and the confirmation.
    await addUser(install.owner, { login: "max-dev", githubAccountId: idOf("max-dev") });
    expect(await problemOf(await post())).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    expect(await invitesFor("max-dev")).toEqual([]);
    expect(await eventsSince()).toEqual([]);
  });
});

// The invite form looks the username up at once, before any review page (D50 (12)); its refusals come with no
// review page, and it creates nothing.
describe("the invite form's username", () => {
  it("that names no GitHub account gets 404 and an RFC 9457 problem, with no review page, and creates no invite", async () => {
    const answer = await submitInviteForm(install, ada, "no-such-user-9f2");
    expect(reviewPathOf(answer)).toBeUndefined();
    expect(await problemOf(answer)).toEqual({ status: 404, type: "https://tiehall.com/problems/record-not-found" });
    expect(await invitesFor("no-such-user-9f2")).toEqual([]);
    expect(await eventsSince()).toEqual([]);
  });

  it("that names a GitHub organization, not a person's account, gets 404 and creates no invite", async () => {
    const answer = await submitInviteForm(install, ada, "acme");
    expect(reviewPathOf(answer)).toBeUndefined();
    expect((await problemOf(answer)).status).toBe(404);
    expect(await invitesFor("acme")).toEqual([]);
  });

  it("for a person who is already a member gets 409, and creates no invite", async () => {
    const answer = await submitInviteForm(install, ada, "sam-dev");
    expect(reviewPathOf(answer)).toBeUndefined();
    expect(await problemOf(answer)).toEqual({ status: 409, type: "https://tiehall.com/problems/conflict" });
    expect(await invitesFor("sam-dev")).toHaveLength(1);
  });

  it("is looked up with an installation token of the install's App, and the account read by its id with one on the review page and at the confirmation", async () => {
    const from = stub.received.length;
    expect((await invite(install, ada, "uma-dev")).status).toBe(200);
    const calls = stub.received.slice(from);
    expect(calls.filter(({ path }) => path === "/users/uma-dev").map(({ token }) => token?.kind)).toEqual(["installation"]);
    expect(calls.filter(({ path }) => path === `/user/${idOf("uma-dev")}`).map(({ token }) => token?.kind)).toEqual(["installation", "installation"]);
  });

  it("is looked up by an admin only, and on no agent surface: a member gets 403, and a token gets 404, even an admin's", async () => {
    expect(await install.web(dana).read("invites.find_account", { login: "zoe-dev" })).toMatchObject({ ok: false, problem: { status: 403 } });
    expect((await submitInviteForm(install, dana, "zoe-dev")).status).toBe(403);
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:read"], surface: "api" };
    await expect(install.execute("invites.find_account", token, { login: "zoe-dev" })).rejects.toMatchObject({ status: 404 });
    expect(await install.web(ada).read("invites.find_account", { login: "zoe-dev" })).toEqual({
      ok: true,
      output: { account: { id: idOf("zoe-dev"), githubLogin: "zoe-dev" } },
    });
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
    expect((await invite(install, ada, "vic-dev")).status).toBe(200);
    stub.renameUser("vic-dev", "vic-k");
    stub.addUser({ login: "vic-dev" });
    expect((await harness.signIn("vic-dev")).response.status).toBe(403);
    expect((await invitesFor("vic-dev"))[0]).toMatchObject({ github_account_id: String(idOf("vic-dev")), accepted_at: null });
    expect((await harness.signIn("vic-k")).response.status).toBe(302);
    expect(await roleOf("vic-k")).toBe("member");
  });
});

describe("creating an invite", () => {
  it("without the confirmation step gets 403, and creates no invite", async () => {
    const result = await install.web(ada).write("invites.create", { accountId: idOf("zoe-dev") }, install.fromThePage(ada));
    expect(result).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/confirmation-required" } });
    expect(await invitesFor("zoe-dev")).toEqual([]);
  });

  it("by a member gets 403, and creates no invite", async () => {
    const answer = await install.confirm(dana, "invites.create", { accountId: idOf("zoe-dev") });
    expect((await problemOf(answer)).status).toBe(403);
    expect(await invitesFor("zoe-dev")).toEqual([]);
  });

  it("that names the role owner gets 400", async () => {
    const answer = await install.confirm(ada, "invites.create", { accountId: idOf("zoe-dev"), role: "owner" });
    expect(await problemOf(answer)).toEqual({ status: 400, type: "https://tiehall.com/problems/invalid-input" });
  });

  it("for an account id GitHub knows no account by gets 404 on its review page, and creates no invite", async () => {
    const answer = await install.confirm(ada, "invites.create", { accountId: 987_654_321 });
    expect(await problemOf(answer)).toEqual({ status: 404, type: "https://tiehall.com/problems/record-not-found" });
    expect(await eventsSince()).toEqual([]);
  });

  it("is offered on no agent surface: a token gets 404, even an admin's", async () => {
    const token: Caller = { kind: "personal_access_token", userId: ada.userId, tokenId: randomUUID(), scopes: ["requests:write"], surface: "api" };
    await expect(install.execute("invites.create", token, { accountId: idOf("zoe-dev") })).rejects.toMatchObject({ status: 404 });
  });
});

/** Makes the install reach GitHub through this fetch until the test ends, with the client's timeout lowered when a test gives one. */
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

/** The path of a request to GitHub. */
function pathOf(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : String(input)).pathname;
}

/**
 * GitHub's answer, given only after this many milliseconds: the request's
 * signal, which the client's timeout aborts, ends the wait first, as it ends a
 * request GitHub has not answered.
 */
function answerAfter(signal: AbortSignal | null | undefined, delayMs: number, answer: () => Promise<Response>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(answer()), delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const SERVER_ERROR = () => new Response('{"message":"Server Error"}', { status: 500, headers: { "content-type": "application/json" } });
const UNAVAILABLE = { status: 502, type: "https://tiehall.com/problems/integration-unavailable" };

// GitHub is asked outside any transaction (design.md, Technical decisions: T3 and T16): the form's look-up of
// the username, the review page's read of the account and the confirmation's read of it again each run before
// any transaction opens, and the confirmation's before its nonce is used, so a slow GitHub holds no connection
// in a transaction and no lock, and a GitHub that fails leaves the confirmation unused, so the admin can post the
// same review page again (github-layer-hardening: design.md, Technical decisions: T6).
describe("inviting while GitHub answers slowly or fails", () => {
  /** The other sessions of this database that are in a transaction and waiting for their client, such as for GitHub. */
  async function idleInTransaction(): Promise<string[]> {
    const { rows } = await install.owner.query<{ state: string }>(
      "SELECT state FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'",
    );
    return rows.map(({ state }) => state);
  }

  /** Runs the call while GitHub holds the request to this path, and says which transactions were open while it held it. */
  async function openWhileHeld<T>(path: string, call: () => Promise<T>): Promise<{ open: string[]; result: T }> {
    let asked: () => void = () => {};
    const held = new Promise<void>((resolve) => (asked = resolve));
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let outcome: { open: string[]; result: T } | undefined;
    await reachingGitHubThrough(
      async (input, init) => {
        if (pathOf(input) === path) {
          asked();
          await released;
        }
        return fetch(input, init);
      },
      async () => {
        const running = call();
        await held;
        let open: string[];
        try {
          open = await idleInTransaction();
        } finally {
          release();
        }
        outcome = { open, result: await running };
      },
    );
    return outcome!;
  }

  it("holds no transaction open while GitHub names the account", { timeout: 30_000 }, async () => {
    const post = await prepareInvite(install, ada, "ned-dev");
    const { open, result } = await openWhileHeld(`/user/${idOf("ned-dev")}`, post);
    expect(open).toEqual([]);
    expect(result.status).toBe(200);
    expect(await invitesFor("ned-dev")).toHaveLength(1);
  });

  it("holds no transaction open while GitHub looks the username up for the form", { timeout: 30_000 }, async () => {
    const { open, result } = await openWhileHeld("/users/ann-dev", () => submitInviteForm(install, ada, "ann-dev"));
    expect(open).toEqual([]);
    expect(reviewInputOf(result)).toEqual({ accountId: idOf("ann-dev"), role: "member" });
  });

  it("holds no transaction open while GitHub reads the account for the review page", { timeout: 30_000 }, async () => {
    const path = reviewPathOf(await submitInviteForm(install, ada, "bea-dev"))!;
    const { open, result } = await openWhileHeld(`/user/${idOf("bea-dev")}`, () => reviewPage(ada, path));
    expect(open).toEqual([]);
    expect(result.status).toBe(200);
  });

  it("that GitHub fails leaves the confirmation unused, so the same review page's form creates the invite once GitHub answers", async () => {
    const post = await prepareInvite(install, ada, "oli-dev");
    let failing = true;
    await reachingGitHubThrough(
      async (input, init) => (failing && pathOf(input) === `/user/${idOf("oli-dev")}` ? SERVER_ERROR() : fetch(input, init)),
      async () => {
        expect(await problemOf(await post())).toEqual(UNAVAILABLE);
        expect(await invitesFor("oli-dev")).toEqual([]);
        expect(await eventsSince()).toEqual([]);
        failing = false;
        expect((await post()).status).toBe(200);
      },
    );
    expect(await invitesFor("oli-dev")).toHaveLength(1);
  });

  // D50 (3): not answering within the client's timeout, lowered here from its 10 seconds, is the same failure.
  it("that GitHub does not answer in time leaves the confirmation unused, so the same review page's form creates the invite once GitHub answers", async () => {
    const post = await prepareInvite(install, ada, "pat-dev");
    let slow = true;
    await reachingGitHubThrough(
      async (input, init) =>
        slow && pathOf(input) === `/user/${idOf("pat-dev")}` ? answerAfter(init?.signal, 2_000, () => fetch(input, init)) : fetch(input, init),
      async () => {
        expect(await problemOf(await post())).toEqual(UNAVAILABLE);
        expect(await invitesFor("pat-dev")).toEqual([]);
        expect(await eventsSince()).toEqual([]);
        slow = false;
        expect((await post()).status).toBe(200);
      },
      200,
    );
    expect(await invitesFor("pat-dev")).toHaveLength(1);
  });

  it("that GitHub fails on the form gets 502 integration-unavailable, with no review page, and creates no invite", async () => {
    await reachingGitHubThrough(
      async (input, init) => (pathOf(input) === "/users/cai-dev" ? SERVER_ERROR() : fetch(input, init)),
      async () => {
        const answer = await submitInviteForm(install, ada, "cai-dev");
        expect(reviewPathOf(answer)).toBeUndefined();
        expect(await problemOf(answer)).toEqual(UNAVAILABLE);
      },
    );
    expect(await invitesFor("cai-dev")).toEqual([]);
    expect(await eventsSince()).toEqual([]);
  });

  it("that GitHub fails, or does not answer in time, on the review page gets 502 integration-unavailable, and creates no invite", async () => {
    const path = reviewPathOf(await submitInviteForm(install, ada, "dee-dev"))!;
    const read = `/user/${idOf("dee-dev")}`;
    await reachingGitHubThrough(
      async (input, init) => (pathOf(input) === read ? SERVER_ERROR() : fetch(input, init)),
      async () => expect(await problemOf(await reviewPage(ada, path))).toEqual(UNAVAILABLE),
    );
    await reachingGitHubThrough(
      async (input, init) => (pathOf(input) === read ? answerAfter(init?.signal, 2_000, () => fetch(input, init)) : fetch(input, init)),
      async () => expect(await problemOf(await reviewPage(ada, path))).toEqual(UNAVAILABLE),
      200,
    );
    expect(await invitesFor("dee-dev")).toEqual([]);
    expect(await eventsSince()).toEqual([]);
  });
});

// One pending invite per account (teams-and-roles: Invites by GitHub username; teams-and-roles: Revoking an
// invite; D50 (11)): a new invite for an account that has a pending invite, neither accepted, revoked nor
// expired, replaces it. The older invite is revoked in the same write that creates the new one, and both are
// security events; an invite that is no longer pending is left as it is.
describe("a new invite for an account with a pending invite", () => {
  let pia: WebSessionCaller;

  beforeAll(async () => {
    pia = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "pia" }), sessionId: randomUUID() };
    for (const login of ["rae-dev", "rex-dev", "rio-dev"]) accounts.set(login, stub.addUser({ login }));
  });

  interface Invite {
    id: string;
    role: string;
    created_at: Date;
    revoked_at: Date | null;
    revoked_by: string | null;
    accepted_at: Date | null;
  }

  async function allInvitesFor(login: string): Promise<Invite[]> {
    const { rows } = await install.owner.query<Invite>(
      "SELECT id, role, created_at, revoked_at, revoked_by, accepted_at FROM invites WHERE github_account_id = $1 ORDER BY created_at, id",
      [idOf(login)],
    );
    return rows;
  }

  /** The account's invites that neither a sign-in accepted nor an admin revoked, and that have not expired. */
  async function pendingFor(login: string): Promise<string[]> {
    const { rows } = await install.owner.query<{ id: string }>(
      "SELECT id FROM invites WHERE github_account_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
      [idOf(login)],
    );
    return rows.map(({ id }) => id);
  }

  it("revokes the pending invite in the same write, records both, lists one invite, and the sign-in accepts the new one with its role", async () => {
    const first = await invited("rae-dev");
    lastEvent = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);

    expect((await invite(install, ada, "rae-dev", "admin")).status).toBe(200);

    const [older, newer] = await allInvitesFor("rae-dev");
    expect(older).toMatchObject({ id: first, role: "member", revoked_by: ada.userId, accepted_at: null });
    expect(newer).toMatchObject({ role: "admin", revoked_at: null, accepted_at: null });
    // In the same write: the revocation's time is the transaction's, the same as the new invite's creation.
    expect(older!.revoked_at).toEqual(newer!.created_at);
    expect(await eventsSince()).toEqual([
      { type: "invite.revoked", class: "security", data: { inviteId: first }, actor_user_id: ada.userId },
      { type: "invite.created", class: "security", data: { inviteId: newer!.id, role: "admin" }, actor_user_id: ada.userId },
    ]);
    const listed = await install.web(ada).read<{ invites: { id: string; githubLogin: string; role: string }[] }>("invites.list", {});
    expect(listed.ok && listed.output.invites.filter(({ githubLogin }) => githubLogin === "rae-dev")).toEqual([
      expect.objectContaining({ id: newer!.id, role: "admin" }),
    ]);

    expect((await harness.signIn("rae-dev")).response.status).toBe(302);
    expect(await roleOf("rae-dev")).toBe("admin");
    const [stillRevoked, accepted] = await allInvitesFor("rae-dev");
    expect(accepted!.accepted_at).not.toBeNull();
    expect(stillRevoked).toMatchObject({ revoked_by: ada.userId, accepted_at: null });
  });

  it("leaves exactly one pending invite when two admins confirm invites for the same account at once", { timeout: 30_000 }, async () => {
    const posts = [await prepareInvite(install, ada, "rex-dev", "member"), await prepareInvite(install, pia, "rex-dev", "admin")];
    // Both confirmations' reads of the account are held until both are asked, so both writes start together.
    let arrived = 0;
    let bothAsked: () => void = () => {};
    const together = new Promise<void>((resolve) => (bothAsked = resolve));
    await reachingGitHubThrough(
      async (input, init) => {
        if (pathOf(input) === `/user/${idOf("rex-dev")}`) {
          arrived += 1;
          if (arrived === 2) bothAsked();
          await together;
        }
        return fetch(input, init);
      },
      async () => {
        const answers = await Promise.all(posts.map((post) => post()));
        expect(answers.map(({ status }) => status)).toEqual([200, 200]);
      },
    );
    const all = await allInvitesFor("rex-dev");
    expect(all).toHaveLength(2);
    expect(await pendingFor("rex-dev")).toHaveLength(1);
    expect(all.filter(({ revoked_at }) => revoked_at !== null)).toHaveLength(1);
    const types = (await eventsSince()).map(({ type }) => type).sort();
    expect(types).toEqual(["invite.created", "invite.created", "invite.revoked"]);
  });

  it("leaves an invite that is revoked or expired as it is, and records no revocation for it", async () => {
    const revoked = await invited("rio-dev");
    expect(await revoke(ada, revoked)).toMatchObject({ ok: true });
    const expired = await invited("rio-dev");
    await install.owner.query("UPDATE invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [expired]);
    const before = await allInvitesFor("rio-dev");
    lastEvent = Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);

    expect((await invite(install, pia, "rio-dev")).status).toBe(200);

    const after = await allInvitesFor("rio-dev");
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.find(({ id }) => id === expired)).toMatchObject({ revoked_at: null, revoked_by: null });
    expect((await eventsSince()).map(({ type }) => type)).toEqual(["invite.created"]);
  });
});

/** Creates an invite for this username as Ada does, through the form and the review page; returns its id. */
async function invited(login: string): Promise<string> {
  expect((await invite(install, ada, login)).status).toBe(200);
  return (await invitesFor(login)).at(-1)!.id;
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
    const revocation = async () => (await install.owner.query("SELECT revoked_at, revoked_by FROM invites WHERE id = $1", [inviteId])).rows;
    const first = await revocation();
    expect(await revoke(ada, inviteId)).toEqual({ ok: true, output: { invite: inviteId, revoked: true } });
    expect(await eventsSince()).toEqual([]);
    expect(await revocation()).toEqual(first);
  });

  it("by a member gets 403, and the invite stays valid", async () => {
    const inviteId = await invited("yan-dev");
    expect(await revoke(dana, inviteId)).toMatchObject({ ok: false, problem: { status: 403, type: "https://tiehall.com/problems/forbidden" } });
    expect((await harness.signIn("yan-dev")).response.status).toBe(302);
    expect(await roleOf("yan-dev")).toBe("member");
  });

  it("that an accepted invite gets 409, and changes nothing", async () => {
    const [accepted] = await invitesFor("yan-dev");
    expect(await revoke(ada, accepted!.id)).toMatchObject({ ok: false, problem: { status: 409 } });
    expect((await invitesFor("yan-dev"))[0]?.accepted_at).not.toBeNull();
    // The invite is not revoked, its person stays a member, and the activity log gains no revocation.
    expect((await install.owner.query("SELECT revoked_at FROM invites WHERE id = $1", [accepted!.id])).rows).toEqual([{ revoked_at: null }]);
    expect(await roleOf("yan-dev")).toBe("member");
    expect(await eventsSince()).toEqual([]);
  });

  it("that names no invite gets 404", async () => {
    expect(await revoke(ada, randomUUID())).toMatchObject({ ok: false, problem: { status: 404, type: "https://tiehall.com/problems/record-not-found" } });
  });

  it("from another origin gets 403, as every web UI write does", async () => {
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
