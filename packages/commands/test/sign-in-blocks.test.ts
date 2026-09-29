import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { SIGN_IN_REFUSED, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type CookieJar, type SignInHarness } from "./support/sign-in.ts";

// An admin removal blocks rejoining through the organization (sign-in: An
// admin removal blocks rejoining through the organization; teams-and-roles:
// Removing a member; activity-log: Which actions are security events;
// design.md, Self-hosting decisions: S5). When an admin removes a member,
// Tiehall records a block on their GitHub account id: membership of a GitHub
// organization no longer admits it, and a sign-in that only such membership
// would admit gets 403 and the text that says to ask an admin for an invite.
// Only an invite an admin creates after the removal admits the account again,
// and the sign-in that accepts it clears the block; its security events name
// the clearing. The person rejoins with the invite's role, in no team, and
// with nothing from before: the web sessions the removal ended stay ended.
// Agent grants and personal access tokens come with group 15, whose task
// 15.19 checks that a rejoined person's old ones stay refused.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let ada: WebSessionCaller;
let lee: WebSessionCaller;
let leeBrowser: CookieJar;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["omar-acme", "lee-acme"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "omar-acme": "admin", "lee-acme": "member" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  install.useGitHub(harness.github);
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'FE', 'Frontend' FROM orgs");
  // Lee joins through membership of acme, and an admin adds them to team FE.
  const signedIn = await harness.signIn("lee-acme");
  expect(signedIn.response.status).toBe(302);
  leeBrowser = signedIn.jar;
  lee = (await harness.sessionOf(leeBrowser))!;
  await install.owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT org_id, id, $1 FROM teams WHERE key = 'FE'", [lee.userId]);
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

async function membershipOf(userId: string): Promise<{ role: string; teams: string[] } | undefined> {
  const { rows } = await install.owner.query<{ role: string; teams: string[] }>(
    `SELECT m.role, coalesce(array_agg(t.key ORDER BY t.key) FILTER (WHERE t.key IS NOT NULL), '{}') AS teams
       FROM members m LEFT JOIN team_members tm ON tm.org_id = m.org_id AND tm.user_id = m.user_id
       LEFT JOIN teams t ON t.org_id = tm.org_id AND t.id = tm.team_id
      WHERE m.user_id = $1 GROUP BY m.role`,
    [userId],
  );
  return rows[0];
}

async function isBlocked(): Promise<boolean> {
  const { rows } = await install.owner.query("SELECT 1 FROM sign_in_blocks WHERE github_account_id = $1", [accounts.get("lee-acme")!.id]);
  return rows.length === 1;
}

async function lastEvent(): Promise<number> {
  return Number((await install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
}

async function eventsSince(number: number): Promise<{ type: string; data: Record<string, unknown> }[]> {
  return (await install.owner.query("SELECT type, data FROM events WHERE number > $1 ORDER BY number", [number])).rows;
}

describe("a removed organization member", () => {
  it("who signs in again gets 403 and the text that says to ask an admin for an invite", async () => {
    expect((await install.confirm(ada, "members.remove", { userId: lee.userId })).status).toBe(200);
    expect(await isBlocked()).toBe(true);
    const { response, jar } = await harness.signIn("lee-acme");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(SIGN_IN_REFUSED);
    expect(await harness.sessionOf(jar)).toBeUndefined();
    expect(await membershipOf(lee.userId)).toBeUndefined();
  });

  it("is not admitted by an invite created before the removal", async () => {
    // An older invite of Lee's account that no sign-in accepted, such as a second one an admin once created.
    await install.owner.query(
      `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at)
         SELECT id, $1, 'lee-acme', 'admin', $2, now() - interval '1 day', now() + interval '6 days' FROM orgs`,
      [accounts.get("lee-acme")!.id, ada.userId],
    );
    await install.owner.query("UPDATE sign_in_blocks SET created_at = now() - interval '1 hour' WHERE github_account_id = $1", [accounts.get("lee-acme")!.id]);
    expect((await harness.signIn("lee-acme")).response.status).toBe(403);
    expect(await membershipOf(lee.userId)).toBeUndefined();
    expect(await isBlocked()).toBe(true);
  });

  it("is admitted by an invite created after the removal, which clears the block, and the sign-in's security events name the clearing", async () => {
    expect((await install.confirm(ada, "invites.create", { login: "lee-acme" })).status).toBe(200);
    const { rows } = await install.owner.query<{ id: string }>("SELECT id FROM invites WHERE role = 'member' AND github_login = 'lee-acme'");
    const from = await lastEvent();
    const { response, jar } = await harness.signIn("lee-acme");
    expect(response.status).toBe(302);
    expect((await harness.sessionOf(jar))?.userId).toBe(lee.userId);
    expect(await isBlocked()).toBe(false);
    expect(await eventsSince(from)).toEqual([
      { type: "member.joined", data: { userId: lee.userId, role: "member", through: "invite", inviteId: rows[0]!.id, blockCleared: true } },
      { type: "sign_in.completed", data: { userId: lee.userId, blockCleared: true } },
    ]);
  });

  it("rejoins with the invite's role, in no team, and the web session the removal ended stays ended", async () => {
    expect(await membershipOf(lee.userId)).toEqual({ role: "member", teams: [] });
    await expect(harness.sessionOf(leeBrowser)).rejects.toMatchObject({ status: 403, type: "https://tiehall.com/problems/removed-member" });
  });

  it("signs in later with no block to clear, and the sign-in names none", async () => {
    const from = await lastEvent();
    expect((await harness.signIn("lee-acme")).response.status).toBe(302);
    expect(await eventsSince(from)).toEqual([{ type: "sign_in.completed", data: { userId: lee.userId } }]);
  });
});
