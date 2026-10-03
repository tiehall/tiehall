import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSessionCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { startAgentAccess, type AgentAccessHarness, type AgentClient, type SignedIn } from "./support/agent-access.ts";

// A removal revokes the person's agent grants and personal access tokens
// (teams-and-roles: Removing a member; teams-and-roles: Membership is
// re-checked on every call; sign-in: An admin removal blocks rejoining through
// the organization; agent-access: Every token call is checked against the
// install's current state; activity-log: Which actions are security events;
// design.md, Decisions this change rests on: D28 #4, #10; design.md,
// Self-hosting decisions: S5 and S14). When an admin removes Dana, every grant
// Dana gave an agent client, the tiehall CLI's included, and every personal
// access token Dana holds is revoked in the removal's own write, each with its
// security event, so none of them works again: while Dana is not a member, a
// call with one of them gets 403, as for a removed member, and a refresh gets
// invalid_grant; once an invite admits Dana again, the old PAT and the old
// access token get 401 as revoked tokens, the old refresh tokens still get
// invalid_grant, and Dana starts with no grant and no token from before.

let harness: AgentAccessHarness;
let ada: WebSessionCaller;
let dana: SignedIn;
let agent: { client: AgentClient; accessToken: string; refreshToken: string | undefined };
let cli: { accessToken: string; refreshToken: string };
let pat: string;
let removedAt: number;

beforeAll(async () => {
  harness = await startAgentAccess();
  ada = sessionOf(await addUser(harness.install.owner, { role: "admin", login: "ada" }));
  dana = await harness.member("dana-k");
  agent = await harness.tokens(dana, ["requests:read"]);
  cli = await harness.signInCli(dana);
  pat = await harness.personalAccessToken(dana, { name: "Dana's script" });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The claims of a JWT access token. */
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

/** A call to /api/v1 with a token: its status and its problem type, if any. */
async function call(token: string): Promise<{ status: number; type: string | undefined }> {
  const answer = await harness.api("GET", "/api/v1/requests", bearer(token));
  const body = (await answer.json()) as { type?: string };
  return { status: answer.status, type: answer.status === 200 ? undefined : body.type };
}

const REMOVED = { status: 403, type: "https://tiehall.com/problems/removed-member" };
const REVOKED = { status: 401, type: "https://tiehall.com/problems/invalid-token" };

describe("before the removal", () => {
  it("Dana's PAT, the agent's access token and the CLI's access token act for Dana", async () => {
    for (const token of [pat, agent.accessToken, cli.accessToken]) expect(await call(token)).toEqual({ status: 200, type: undefined });
  });
});

describe("an admin's removal of Dana", () => {
  beforeAll(async () => {
    removedAt = Number((await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    const answer = await harness.install.confirm(ada, "members.remove", { userId: dana.userId }, { "x-forwarded-for": "198.51.100.60", "user-agent": "Mozilla/5.0 (ada)" });
    expect(answer.status).toBe(200);
  });

  it("revokes Dana's grants and PAT in its own write, each with its security event", async () => {
    const { rows: grants } = await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_consents WHERE user_id = $1", [dana.userId]);
    expect(grants[0].n).toBe(0);
    const { rows: tokens } = await harness.install.owner.query("SELECT revoked_at IS NOT NULL AS revoked FROM personal_access_tokens WHERE user_id = $1", [dana.userId]);
    expect(tokens).toEqual([{ revoked: true }]);
    const { rows: refresh } = await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE user_id = $1 AND revoked IS NULL", [dana.userId]);
    expect(refresh[0].n).toBe(0);
    const { rows } = await harness.install.owner.query(
      "SELECT type, actor_user_id, data->>'userId' AS user_id FROM events WHERE number > $1 AND class = 'security' ORDER BY number",
      [removedAt],
    );
    expect(rows.map(({ type }) => type).sort()).toEqual(["agent_grant.revoked", "agent_grant.revoked", "member.removed", "personal_access_token.revoked"]);
    for (const row of rows) expect(row).toMatchObject({ actor_user_id: ada.userId, user_id: dana.userId });
  });

  it("makes every call with Dana's PAT or access tokens get 403 while Dana is not a member", async () => {
    for (const token of [pat, agent.accessToken, cli.accessToken]) expect(await call(token)).toEqual(REMOVED);
  });

  it("makes the agent's and the CLI's refresh tokens get invalid_grant", async () => {
    const refreshed = await harness.refresh(agent.client, agent.refreshToken ?? "");
    expect(refreshed.body["error"]).toBe("invalid_grant");
    const cliRefreshed = await harness.refresh({ clientId: "tiehall-cli", redirectUri: "" }, cli.refreshToken);
    expect(cliRefreshed.body["error"]).toBe("invalid_grant");
  });
});

describe("Dana, once an invite admits them again", () => {
  beforeAll(async () => {
    // An access token records the second it was issued; a rejoin takes more than a second in any real install.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // An admin invites Dana's GitHub account after the removal, and Dana signs in with it.
    await harness.install.owner.query(
      `INSERT INTO invites (org_id, github_account_id, github_login, role, created_by, created_at, expires_at)
         SELECT o.id, u.github_account_id, u.github_login, 'member', $2, now(), now() + interval '7 days' FROM orgs o, users u WHERE u.id = $1`,
      [dana.userId, ada.userId],
    );
    const { response, jar } = await harness.signIn.signIn("dana-k");
    expect(response.status).toBe(302);
    dana = { userId: dana.userId, cookie: jar.header() };
    const { rows } = await harness.install.owner.query("SELECT role FROM members WHERE user_id = $1", [dana.userId]);
    expect(rows).toEqual([{ role: "member" }]);
  });

  it("finds the old PAT refused with 401 as a revoked token", async () => {
    expect(await call(pat)).toEqual(REVOKED);
  });

  it("finds the access tokens issued before the removal refused with 401, although they have not expired", async () => {
    for (const token of [agent.accessToken, cli.accessToken]) expect(await call(token)).toEqual(REVOKED);
  });

  // A token names the membership it was issued in, by the number each new membership gets, so the check needs no
  // clock: not the issue time the app's clock gave it, nor the start of the membership the database's clock gave.
  it("finds them refused still when the database's clock puts the new membership's start before they were issued", async () => {
    await harness.install.owner.query("UPDATE members SET joined_at = now() - interval '1 hour' WHERE user_id = $1", [dana.userId]);
    for (const token of [agent.accessToken, cli.accessToken]) expect(await call(token)).toEqual(REVOKED);
  });

  it("finds the old refresh tokens refused with invalid_grant", async () => {
    expect((await harness.refresh(agent.client, agent.refreshToken ?? "")).body["error"]).toBe("invalid_grant");
    expect((await harness.refresh({ clientId: "tiehall-cli", redirectUri: "" }, cli.refreshToken)).body["error"]).toBe("invalid_grant");
  });

  it("holds no grant and no token from before: the Connected agents and tokens page lists none", async () => {
    const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: dana.cookie } }))).text();
    expect(page).toContain("You have approved no agent client.");
    expect(page).toContain("You have no personal access token.");
  });

  it("can sign the CLI in and create a PAT again, which work", async () => {
    const again = await harness.signInCli(dana);
    const newPat = await harness.personalAccessToken(dana, { name: "Dana's new script" });
    for (const token of [again.accessToken, newPat]) expect(await call(token)).toEqual({ status: 200, type: undefined });
    // The new access tokens, the CLI's and an agent's, name the membership they were issued in.
    const { rows } = await harness.install.owner.query("SELECT token_generation::text AS generation FROM members WHERE user_id = $1", [dana.userId]);
    const agentAgain = await harness.tokens(dana, ["requests:read"]);
    for (const token of [again.accessToken, agentAgain.accessToken]) expect(String(claimsOf(token)["tiehall_membership"])).toBe(rows[0].generation);
    expect(await call(agentAgain.accessToken)).toEqual({ status: 200, type: undefined });
  });
});
