import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, DEVICE_CODE_GRANT_TYPE } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { holdRow, untilWaiting } from "./support/locks.ts";
import { hiddenField, MCP_RESOURCE, pkcePair, startAgentAccess, type AgentAccessHarness, type AgentClient, type Pkce, type SignedIn } from "./support/agent-access.ts";

// A revoked grant yields nothing more (agent-access: Users list and revoke
// their own agent grants and tokens; agent-access: Approving an agent client
// uses the confirmation step; design.md, Decisions this change rests on: D28
// #47; design.md, Self-hosting decisions: S14). Revoking a grant on the
// Connected agents and tokens page stops everything the client holds from
// that grant but the access tokens already issued, which expire within 10
// minutes: its refresh tokens, and also an authorization code it was given and
// has not exchanged yet, and a device code the person approved that the CLI
// has not exchanged yet. A client that exchanges one of them while the
// revocation commits gets no token, and no refresh token of it is left that
// works while the page lists no grant for Ana to revoke.

let harness: AgentAccessHarness;

beforeAll(async () => {
  harness = await startAgentAccess();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** The Connected agents and tokens page, as the person's browser opens it. */
async function tokensPage(person: SignedIn): Promise<string> {
  const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: person.cookie, accept: "text/html" } }));
  expect(answer.status).toBe(200);
  return answer.text();
}

/** Revokes a grant with the page's form, as the person's browser does. */
async function revokeOnThePage(person: SignedIn, clientId: string): Promise<Response> {
  const { rows } = await harness.install.owner.query("SELECT id FROM oauth_consents WHERE user_id = $1 AND client_id = $2", [person.userId, clientId]);
  const grantId = String(rows[0]?.id ?? "");
  expect(grantId).not.toBe("");
  const csrf = hiddenField(await tokensPage(person), "csrf");
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/tokens`, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ action: "revoke_grant", grant: grantId, csrf }).toString(),
    }),
  );
}

/** An authorization code the client got for the person, which it keeps unexchanged. */
async function codeFor(person: SignedIn, client: AgentClient): Promise<{ code: string; pkce: Pkce }> {
  const pkce = pkcePair();
  const answer = await harness.authorize(person.cookie, client, pkce, { scope: "requests:read" });
  const code = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code");
  if (code === null) throw new Error(`the authorization gave no code: ${answer.status} ${answer.headers.get("location")}`);
  return { code, pkce };
}

/** The refresh tokens of the person for the client that are not revoked. */
async function liveRefreshTokens(person: SignedIn, clientId: string): Promise<number> {
  const { rows } = await harness.install.owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE user_id = $1 AND client_id = $2 AND revoked IS NULL",
    [person.userId, clientId],
  );
  return rows[0]?.n ?? 0;
}

describe("a grant revoked on the page", () => {
  it("leaves an authorization code the client kept unexchanged worth nothing: invalid_grant", async () => {
    const ana = await harness.member("ana-code");
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const { code, pkce } = await codeFor(ana, client);
    expect((await revokeOnThePage(ana, client.clientId)).status).toBe(303);
    expect(await tokensPage(ana)).toContain("You have approved no agent client.");
    // Within the code's 10 minutes, the client exchanges it.
    const exchanged = await harness.exchange(client, code, pkce);
    expect(exchanged.body["error"]).toBe("invalid_grant");
    expect(exchanged.body["access_token"]).toBeUndefined();
    expect(exchanged.body["refresh_token"]).toBeUndefined();
    expect(await liveRefreshTokens(ana, client.clientId)).toBe(0);
  });

  it("leaves a device code the person approved and the CLI has not exchanged yet worth nothing", async () => {
    const ana = await harness.member("ana-device");
    const form = (fields: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const started = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/device/code`, form({ client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: "requests:read" })),
    );
    const { device_code: deviceCode, user_code: userCode } = (await started.json()) as { device_code: string; user_code: string };
    const fromThePage = { cookie: ana.cookie, accept: "text/html", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
    const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/device`, { headers: { cookie: ana.cookie } }))).text();
    const review = await (
      await harness.handle(
        new Request(`${URL_OF_INSTALL}/device`, { method: "POST", headers: fromThePage, body: new URLSearchParams({ user_code: userCode, csrf: hiddenField(page, "csrf") }).toString() }),
      )
    ).text();
    const approved = await harness.handle(
      new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve_device`, {
        method: "POST",
        headers: fromThePage,
        body: new URLSearchParams({ input: hiddenField(review, "input"), nonce: hiddenField(review, "nonce"), csrf: hiddenField(review, "csrf") }).toString(),
      }),
    );
    expect(approved.status).toBe(200);
    // Ana revokes the CLI's grant before the CLI's next poll.
    expect((await revokeOnThePage(ana, CLI_CLIENT_ID)).status).toBe(303);
    const polled = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, form({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode, client_id: CLI_CLIENT_ID })),
    );
    const body = (await polled.json()) as Record<string, unknown>;
    // The device code was denied with the grant, as if Ana had denied it on the page.
    expect(body["error"]).toBe("access_denied");
    expect(body["access_token"]).toBeUndefined();
    expect(body["refresh_token"]).toBeUndefined();
    expect(await liveRefreshTokens(ana, CLI_CLIENT_ID)).toBe(0);
  });

  it("gives a client that exchanges a code while the revocation commits no token, and leaves it no refresh token", async () => {
    const ana = await harness.member("ana-race");
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const { code, pkce } = await codeFor(ana, client);
    // The exchange stores its refresh token while the revocation commits: the client's row, which the new token's
    // foreign key reads, is held until the revocation has committed.
    const held = await holdRow(harness.install.databaseUrl, "SELECT id FROM oauth_clients WHERE client_id = $1 FOR UPDATE", [client.clientId]);
    const exchanging = harness.exchange(client, code, pkce);
    await untilWaiting(harness.install.owner, 1);
    expect((await revokeOnThePage(ana, client.clientId)).status).toBe(303);
    await held.release();
    const exchanged = await exchanging;
    expect(exchanged.body["error"]).toBe("invalid_grant");
    expect(exchanged.body["access_token"]).toBeUndefined();
    expect(exchanged.body["refresh_token"]).toBeUndefined();
    expect(await liveRefreshTokens(ana, client.clientId)).toBe(0);
    expect(await tokensPage(ana)).toContain("You have approved no agent client.");
  });
});
