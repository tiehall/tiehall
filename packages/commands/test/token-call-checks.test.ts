import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { callApi, tokenOf } from "./support/requests.ts";

// Every token call is checked against the install's current state
// (agent-access: Every token call is checked against the install's current
// state; agent-access: Access tokens live 10 minutes and refresh tokens
// rotate; design.md, Decisions this change rests on: D28 #4; design.md,
// Design rules: Agent access). On every call made with an OAuth access token
// or a personal access token, Tiehall checks at the time of the call that the
// token's user is still a member of the install and, for a personal access
// token, that the PAT switch is on; a call that fails either check gets 403
// and no data, whatever the token's expiry. The switch is read at each call,
// so turning it off revokes nothing, and turning it on again lets unexpired
// tokens work again. The OAuth token's lifetime and the refresh token's
// rotation are the conformance tests' (oauth-conformance.test.ts).
//
// Until personal access tokens are created in the web UI (15.14), a PAT's
// call is the caller the PAT check will give; until an admin changes the
// switch in the web UI with the confirmation step (15.15), the tests set it as
// that change stores it.

let harness: AgentAccessHarness;
let ana: SignedIn;
let bob: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  bob = await harness.member("bob-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** Sets the install's PAT switch as an admin's confirmed change stores it. */
async function patSwitch(on: boolean): Promise<void> {
  await harness.install.owner.query(
    `INSERT INTO install_settings (org_id, personal_access_tokens_on) SELECT id, $1 FROM orgs
       ON CONFLICT (org_id) DO UPDATE SET personal_access_tokens_on = excluded.personal_access_tokens_on`,
    [on],
  );
}

describe("the PAT switch", () => {
  it("is on in a new install: a member's personal access token is accepted", async () => {
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM install_settings");
    expect(rows[0].n).toBe(0);
    const answer = await callApi(harness.install, tokenOf(ana.userId), "GET", "/api/v1/requests");
    expect(answer.status).toBe(200);
  });

  it("applies to the next call: once it is off, the script's next call with the same token gets 403 and no data", async () => {
    const pat = tokenOf(ana.userId);
    const before = await callApi(harness.install, pat, "GET", "/api/v1/requests");
    expect(before.status).toBe(200);
    await patSwitch(false);
    try {
      const answer = await callApi<Record<string, unknown>>(harness.install, pat, "GET", "/api/v1/requests");
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({
        type: "https://tiehall.com/problems/personal-access-tokens-off",
        title: "Personal access tokens are switched off",
        status: 403,
        detail: expect.any(String),
      });
    } finally {
      await patSwitch(true);
    }
  });

  it("refuses a write with 403 while it is off, and the write changes nothing", async () => {
    await patSwitch(false);
    try {
      const { rows: before } = await harness.install.owner.query("SELECT count(*)::int AS n FROM events");
      const answer = await callApi(harness.install, tokenOf(ana.userId), "POST", "/api/v1/requests", { title: "Add a dark mode", targetTeam: "FE" });
      expect(answer.status).toBe(403);
      const { rows: after } = await harness.install.owner.query("SELECT count(*)::int AS n FROM events");
      expect(after[0].n).toBe(before[0].n);
    } finally {
      await patSwitch(true);
    }
  });

  it("revokes nothing: turned on again, an unexpired token that was never revoked is accepted again", async () => {
    const pat = tokenOf(ana.userId);
    await patSwitch(false);
    expect((await callApi(harness.install, pat, "GET", "/api/v1/requests")).status).toBe(403);
    await patSwitch(true);
    expect((await callApi(harness.install, pat, "GET", "/api/v1/requests")).status).toBe(200);
  });

  it("does not touch OAuth tokens: an agent client's access token is accepted while PATs are off", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    await patSwitch(false);
    try {
      const answer = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` });
      expect(answer.status).toBe(200);
    } finally {
      await patSwitch(true);
    }
  });
});

describe("the membership re-check", () => {
  it("refuses an unexpired OAuth access token with 403 and no data at its next call once its user is no longer a member", async () => {
    const { accessToken } = await harness.tokens(bob, ["requests:read"]);
    const bearer = { authorization: `Bearer ${accessToken}` };
    expect((await harness.api("GET", "/api/v1/requests", bearer)).status).toBe(200);
    await harness.install.owner.query("DELETE FROM members WHERE user_id = $1", [bob.userId]);
    const answer = await harness.api("GET", "/api/v1/requests", bearer);
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({
      type: "https://tiehall.com/problems/removed-member",
      title: "Removed from the install",
      status: 403,
      detail: expect.any(String),
    });
  });

  it("refuses a personal access token of a user who is no longer a member with 403, whether the switch is on or off", async () => {
    const pat = tokenOf(bob.userId);
    expect((await callApi(harness.install, pat, "GET", "/api/v1/requests")).body).toMatchObject({ status: 403, type: "https://tiehall.com/problems/removed-member" });
    await patSwitch(false);
    try {
      expect((await callApi(harness.install, pat, "GET", "/api/v1/requests")).status).toBe(403);
    } finally {
      await patSwitch(true);
    }
  });
});
