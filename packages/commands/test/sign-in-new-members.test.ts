import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub, type StubUser } from "@tiehall/testing/github";
import { reconcileGitHub } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { startSignIn, type SignInHarness } from "./support/sign-in.ts";

// New members join as members (sign-in: New members join as members;
// design.md, Self-hosting decisions: S5 and S6). A person admitted through
// membership of a GitHub organization joins the install with the role
// `member` and in no team, whatever their role in the organization: roles are
// set in Tiehall and never taken from GitHub. A person who holds a valid
// invite joins through it, with the invite's role, even when membership of a
// GitHub organization would also admit them, so leaving the organization later
// does not end their access.

let install: TestInstall;
let stub: GitHubStub;
let harness: SignInHarness;
let pia: string;
const accounts = new Map<string, StubUser>();

beforeAll(async () => {
  install = await startTestInstall();
  stub = await startGitHubStub();
  for (const login of ["root-acme", "omar-acme", "lee-acme"]) accounts.set(login, stub.addUser({ login }));
  stub.addOrg({ login: "acme", members: { "root-acme": "admin", "omar-acme": "admin", "lee-acme": "member" } });
  harness = await startSignIn(install, stub);
  await stub.install(harness.app, { account: "acme" });
  await harness.connect("acme");
  pia = await addUser(install.owner, { login: "pia", role: "admin" });
  await install.owner.query("INSERT INTO teams (org_id, key, name) SELECT id, 'FE', 'Frontend' FROM orgs");
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await install?.close();
});

/** The member's role and the keys of their teams, by their GitHub login. */
async function membershipOf(login: string): Promise<{ role: string; teams: string[] } | undefined> {
  const { rows } = await install.owner.query<{ role: string; teams: string[] }>(
    `SELECT m.role, coalesce(array_agg(t.key ORDER BY t.key) FILTER (WHERE t.key IS NOT NULL), '{}') AS teams
       FROM members m JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id
       LEFT JOIN team_members tm ON tm.org_id = m.org_id AND tm.user_id = m.user_id
       LEFT JOIN teams t ON t.org_id = tm.org_id AND t.id = tm.team_id
      WHERE u.github_login = $1 GROUP BY m.role`,
    [login],
  );
  return rows[0];
}

async function joinOf(login: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await install.owner.query<{ data: Record<string, unknown> }>(
    `SELECT e.data FROM events e JOIN users u ON u.org_id = e.org_id AND u.id::text = e.data->>'userId'
      WHERE e.type = 'member.joined' AND u.github_login = $1 ORDER BY e.number DESC LIMIT 1`,
    [login],
  );
  return rows[0]?.data;
}

describe("a new member", () => {
  it("who owns the GitHub organization of a connected installation joins with the role member and in no team, when they hold no invite", async () => {
    expect((await harness.signIn("omar-acme")).response.status).toBe(302);
    expect(await membershipOf("omar-acme")).toEqual({ role: "member", teams: [] });
    expect(await joinOf("omar-acme")).toMatchObject({ role: "member", through: "organization" });
  });

  it("who holds a valid invite with the role admin and is also a member of the connected installation's organization joins through the invite, with the role admin", async () => {
    const { rows } = await install.owner.query<{ id: string }>(
      `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at)
         SELECT id, $1, 'lee-acme', 'admin', $2, now() - interval '3 days', now() + interval '4 days' FROM orgs RETURNING id`,
      [accounts.get("lee-acme")!.id, pia],
    );
    expect((await harness.signIn("lee-acme")).response.status).toBe(302);
    expect(await membershipOf("lee-acme")).toEqual({ role: "admin", teams: [] });
    expect(await joinOf("lee-acme")).toEqual({ userId: expect.any(String), role: "admin", through: "invite", inviteId: rows[0]!.id });
    // Joined through the invite, Lee is kept as seen in no organization, so leaving acme cannot end their access.
    const seen = await install.owner.query(
      "SELECT 1 FROM member_organizations mo JOIN users u ON u.org_id = mo.org_id AND u.id = mo.user_id WHERE u.github_login = 'lee-acme'",
    );
    expect(seen.rows).toEqual([]);
  });

  it("who joined through an invite keeps their access after leaving the GitHub organization", async () => {
    await stub.removeMember("acme", "lee-acme", { delivery: "none" });
    await reconcileGitHub.handle(
      { id: randomUUID(), queue: reconcileGitHub.type.queue, data: {}, signal: new AbortController().signal },
      { database: install.db, now: () => new Date(), github: harness.github, execute: install.execute },
    );
    expect(await membershipOf("lee-acme")).toEqual({ role: "admin", teams: [] });
    expect((await harness.signIn("lee-acme")).response.status).toBe(302);
    expect(await membershipOf("lee-acme")).toEqual({ role: "admin", teams: [] });
  });
});
