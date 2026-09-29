import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { SIGN_IN_REFUSED, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInAttempt, type SignInHarness } from "./support/sign-in.ts";

// Sign-ins that race an admin's change (sign-in: Who may sign in; activity-log:
// Which actions are security events). Who may sign in is decided before the
// sign-in service writes anything, and GitHub is asked outside any
// transaction, so an admin's change can commit while GitHub answers: here the
// admin sets the sign-in policy to "invited people only" while GitHub answers
// the sign-in's lookup of the person's organization membership. The join, just
// before the web session is stored, checks the admission again and no longer
// finds it. The sign-in is then refused like any other: 403 with the text that
// says to ask an admin for an invite, no session, no membership, no Tiehall
// user it created, and a security event for the refused sign-in.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-acme", "lou-acme"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin", "lee-acme": "member", "lou-acme": "member" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

beforeEach(async () => {
  await install.owner.query("UPDATE install_settings SET sign_in_policy = 'organization_members_and_invited'");
});

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
}

async function eventsSince(number: number): Promise<{ type: string; data: Record<string, unknown> }[]> {
  return (await install.owner.query("SELECT type, data FROM events WHERE number > $1 ORDER BY number", [number])).rows;
}

async function recordsOf(login: string): Promise<{ users: number; accounts: number; members: number; sessions: number }> {
  const { rows } = await install.owner.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM users WHERE github_login = $1) AS users,
            (SELECT count(*) FROM sign_in_accounts a JOIN users u ON u.org_id = a.org_id AND u.id = a.user_id WHERE u.github_login = $1) AS accounts,
            (SELECT count(*) FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id WHERE u.github_login = $1) AS members,
            (SELECT count(*) FROM web_sessions s JOIN users u ON u.org_id = s.org_id AND u.id = s.user_id WHERE u.github_login = $1) AS sessions`,
    [login],
  );
  const row = rows[0]!;
  return { users: Number(row["users"]), accounts: Number(row["accounts"]), members: Number(row["members"]), sessions: Number(row["sessions"]) };
}

/** A sign-in as this login, during whose lookup of the login's membership of acme an admin sets the policy to invited people only. */
async function signInWhileThePolicyChanges(login: string): Promise<SignInAttempt> {
  let changed = false;
  const racing = await startSignIn(install, stub, {
    sameAppAs: harness,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!changed && url.pathname === `/orgs/acme/members/${login}`) {
        changed = true;
        expect((await install.confirm(ada, "settings.set_sign_in_policy", { policy: "invited_only" })).status).toBe(200);
      }
      return fetch(input, init);
    },
  });
  const attempt = await racing.signIn(login);
  expect(changed).toBe(true);
  return attempt;
}

describe("a sign-in whose admission is withdrawn before its session is stored", () => {
  it("of a new person is refused with 403, leaves no Tiehall user, and is recorded as a refused sign-in naming the GitHub account", async () => {
    const from = await lastEvent();
    const { response, jar } = await signInWhileThePolicyChanges("lee-acme");

    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect(await recordsOf("lee-acme")).toEqual({ users: 0, accounts: 0, members: 0, sessions: 0 });
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["settings.sign_in_policy_changed", "sign_in.refused"]);
    const refused = events[1]!.data;
    expect(Object.keys(refused)).toEqual(["refusalId"]);
    const { rows } = await install.owner.query("SELECT github_account_id, github_login FROM sign_in_refusals WHERE id = $1", [refused["refusalId"]]);
    expect(rows).toEqual([{ github_account_id: String(accounts.get("lee-acme")!.id), github_login: "lee-acme" }]);
  });

  it("of a person whose user exists keeps that user, and the refused sign-in names it", async () => {
    // Lou was a member once and left; their user stays, as a removal leaves it.
    const lou = await addUser(install.owner, { login: "lou-acme", githubAccountId: accounts.get("lou-acme")!.id, role: null });
    const from = await lastEvent();
    const { response } = await signInWhileThePolicyChanges("lou-acme");

    expect(response.status).toBe(403);
    expect(await recordsOf("lou-acme")).toEqual({ users: 1, accounts: 1, members: 0, sessions: 0 });
    const events = await eventsSince(from);
    expect(events.map(({ type }) => type)).toEqual(["settings.sign_in_policy_changed", "sign_in.refused"]);
    expect(events[1]!.data).toMatchObject({ userId: lou });
  });
});
