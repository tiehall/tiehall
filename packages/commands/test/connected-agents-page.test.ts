import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { hiddenField, startAgentAccess, type AgentAccessHarness, type AgentClient, type SignedIn } from "./support/agent-access.ts";

// Users list and revoke their own agent grants and tokens (agent-access: Users
// list and revoke their own agent grants and tokens; activity-log: Which
// actions are security events; design.md, Decisions this change rests on:
// D28 #47; design.md, Self-hosting decisions: S14). Every member's "Connected
// agents and tokens" page, /tokens, lists the grants they gave agent clients,
// the tiehall CLI's included, and their personal access tokens, each with a
// form that revokes it. Revoking a grant stops its refresh token at once;
// access tokens already issued from it stop working when they expire, within
// 10 minutes. A revoked PAT stops working at once. Each revocation is a
// security event. Nobody sees or revokes another person's grants or tokens.

let harness: AgentAccessHarness;
let ana: SignedIn;
let bob: SignedIn;
let agent: { client: AgentClient; accessToken: string; refreshToken: string | undefined };
let cli: { accessToken: string; refreshToken: string };
let anaPat: string;
let bobPat: string;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  bob = await harness.member("bob-k");
  agent = await harness.tokens(ana, ["requests:read"]);
  cli = await harness.signInCli(ana);
  anaPat = await harness.personalAccessToken(ana, { name: "Deploy script" });
  bobPat = await harness.personalAccessToken(bob, { name: "Bob's own script" });
  await harness.tokens(bob, ["requests:read"]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The page, as the person's browser opens it. */
async function page(person: SignedIn): Promise<string> {
  const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: person.cookie, accept: "text/html" } }));
  expect(answer.status).toBe(200);
  return answer.text();
}

/** Posts one of the page's revoke forms, as the person's browser does from the page. */
async function revoke(person: SignedIn, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  const csrf = hiddenField(await page(person), "csrf");
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/tokens`, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: new URLSearchParams({ ...fields, csrf }).toString(),
    }),
  );
}

/** A person's grant to a client, by the client's id. */
async function grantOf(person: SignedIn, clientId: string): Promise<string | undefined> {
  const { rows } = await harness.install.owner.query("SELECT id FROM oauth_consents WHERE user_id = $1 AND client_id = $2", [person.userId, clientId]);
  return rows[0]?.id;
}

/** A person's personal access token, by its label. */
async function tokenOf(person: SignedIn, name: string): Promise<string | undefined> {
  const { rows } = await harness.install.owner.query("SELECT id FROM personal_access_tokens WHERE user_id = $1 AND name = $2", [person.userId, name]);
  return rows[0]?.id;
}

/** The events after that number, with the client address and user agent kept apart. */
async function eventsSince(number: number): Promise<Record<string, unknown>[]> {
  const { rows } = await harness.install.owner.query(
    `SELECT e.type, e.class, e.actor_user_id, e.data, host(o.ip_address) AS ip, o.user_agent
       FROM events e LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
      WHERE e.number > $1 ORDER BY e.number`,
    [number],
  );
  return rows;
}

async function lastEvent(): Promise<number> {
  const { rows } = await harness.install.owner.query("SELECT coalesce(max(number), 0)::int AS n FROM events");
  return rows[0].n;
}

describe("the Connected agents and tokens page", () => {
  it("lists the member's grants, the tiehall CLI's included, and their personal access tokens, and nobody else's", async () => {
    const html = await page(ana);
    expect(html).toContain("Connected agents and tokens");
    expect(html).toContain("Test agent");
    expect(html).toContain("The tiehall CLI");
    expect(html).toContain("Deploy script");
    expect(html).not.toContain("Bob&#39;s own script");
    expect(html).not.toContain(anaPat);
    const grants = [await grantOf(ana, agent.client.clientId), await grantOf(ana, "tiehall-cli")];
    for (const grant of grants) expect(html).toContain(`<input type="hidden" name="grant" value="${grant}">`);
    expect(html).toContain(`<input type="hidden" name="token" value="${await tokenOf(ana, "Deploy script")}">`);
    const bobsGrant = await grantOf(bob, (await harness.install.owner.query("SELECT client_id FROM oauth_consents WHERE user_id = $1 AND client_id <> 'tiehall-cli'", [bob.userId])).rows[0].client_id);
    expect(html).not.toContain(`value="${bobsGrant}"`);
  });

  it("revokes nothing of another member's: their grant and their token get 404 and keep working", async () => {
    const bobsToken = await tokenOf(bob, "Bob's own script");
    const { rows } = await harness.install.owner.query("SELECT id FROM oauth_consents WHERE user_id = $1", [bob.userId]);
    expect((await revoke(ana, { action: "revoke_token", token: bobsToken ?? "" })).status).toBe(404);
    expect((await revoke(ana, { action: "revoke_grant", grant: rows[0].id })).status).toBe(404);
    expect((await harness.api("GET", "/api/v1/requests", bearer(bobPat))).status).toBe(200);
    expect((await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_consents WHERE user_id = $1", [bob.userId])).rows[0].n).toBe(1);
  });

  it("refuses a revoke form not posted from the page with 403, and revokes nothing", async () => {
    const answer = await revoke(ana, { action: "revoke_token", token: (await tokenOf(ana, "Deploy script")) ?? "" }, { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" });
    expect(answer.status).toBe(403);
    expect((await harness.api("GET", "/api/v1/requests", bearer(anaPat))).status).toBe(200);
  });
});

describe("revoking a grant", () => {
  it("stops the MCP client's refresh token at once with invalid_grant, is a security event, and leaves the page", async () => {
    const grant = await grantOf(ana, agent.client.clientId);
    const from = await lastEvent();
    const answer = await revoke(ana, { action: "revoke_grant", grant: grant ?? "" }, { "x-forwarded-for": "198.51.100.51", "user-agent": "Mozilla/5.0 (ana)" });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/tokens");
    const refreshed = await harness.refresh(agent.client, agent.refreshToken ?? "");
    expect(refreshed.status).toBe(400);
    expect(refreshed.body["error"]).toBe("invalid_grant");
    const { rows: clients } = await harness.install.owner.query("SELECT id FROM oauth_clients WHERE client_id = $1", [agent.client.clientId]);
    expect(await eventsSince(from)).toEqual([
      {
        type: "agent_grant.revoked",
        class: "security",
        actor_user_id: ana.userId,
        data: { userId: ana.userId, clientId: clients[0].id, grantId: grant },
        ip: "198.51.100.51",
        user_agent: "Mozilla/5.0 (ana)",
      },
    ]);
    expect(await page(ana)).not.toContain("Test agent");
  });

  it("stops the tiehall CLI's refresh token at once with invalid_grant", async () => {
    const grant = await grantOf(ana, "tiehall-cli");
    expect((await revoke(ana, { action: "revoke_grant", grant: grant ?? "" })).status).toBe(303);
    const refreshed = await harness.refresh({ clientId: "tiehall-cli", redirectUri: "" }, cli.refreshToken);
    expect(refreshed.status).toBe(400);
    expect(refreshed.body["error"]).toBe("invalid_grant");
    expect(await page(ana)).not.toContain("The tiehall CLI");
  });
});

describe("revoking a personal access token", () => {
  it("makes its next call get 401 at once, is a security event, and leaves the page", async () => {
    const tokenId = await tokenOf(ana, "Deploy script");
    expect((await harness.api("GET", "/api/v1/requests", bearer(anaPat))).status).toBe(200);
    const from = await lastEvent();
    const answer = await revoke(ana, { action: "revoke_token", token: tokenId ?? "" }, { "x-forwarded-for": "198.51.100.52", "user-agent": "Mozilla/5.0 (ana)" });
    expect(answer.status).toBe(303);
    const call = await harness.api("GET", "/api/v1/requests", bearer(anaPat));
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await eventsSince(from)).toEqual([
      {
        type: "personal_access_token.revoked",
        class: "security",
        actor_user_id: ana.userId,
        data: { userId: ana.userId, tokenId },
        ip: "198.51.100.52",
        user_agent: "Mozilla/5.0 (ana)",
      },
    ]);
    expect(await page(ana)).not.toContain("Deploy script");
    expect((await revoke(ana, { action: "revoke_token", token: tokenId ?? "" })).status).toBe(404);
  });
});
