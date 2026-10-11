import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, pkcePair, startAgentAccess, type AgentAccessHarness, type AgentClient, type SignedIn } from "./support/agent-access.ts";

// Tiehall is the authorization server for agent clients (agent-access: Tiehall
// is the authorization server for agent clients; design.md, Design rules:
// Agent access; design.md, Technical decisions: T7 and T9; design.md,
// Self-hosting decisions: S13). The sign-in service is the install's own
// OAuth 2.1 authorization server, with the install's URL, TIEHALL_URL, as its
// issuer: it publishes the protected resource metadata of the install's MCP
// resource, which names the install as its authorization server, and the
// authorization server metadata, which offers the authorization code grant
// with refresh tokens, the device grant that only the CLI may use
// (device-flow.test.ts), and never the client credentials grant. Its access
// tokens are JWTs that live 600 seconds, signed with the install's own keys,
// and /api/v1 and /mcp accept them. Checking one reads the install's signing
// keys in the same process, so it makes no outbound call.

let harness: AgentAccessHarness;
let ana: SignedIn;

/** How far a test has moved the clock the install counts each address's calls by, from the real time. */
let elapsedMs = 0;

beforeAll(async () => {
  harness = await startAgentAccess({ clientMetadata: { now: () => new Date(Date.now() + elapsedMs) } });
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function json(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await harness.handle(new Request(`${URL_OF_INSTALL}${path}`));
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the install's authorization server", () => {
  it("publishes the protected resource metadata of /mcp, which names the install as its authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const { status, body } = await json(path);
      expect(status, path).toBe(200);
      expect(body).toMatchObject({ resource: MCP_RESOURCE, authorization_servers: [URL_OF_INSTALL], bearer_methods_supported: ["header"] });
    }
  });

  it("publishes the authorization server metadata, with the install's URL as issuer, the authorization code and refresh token grants and the CLI's device grant only, and S256", async () => {
    const { status, body } = await json("/.well-known/oauth-authorization-server");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      issuer: URL_OF_INSTALL,
      authorization_endpoint: `${URL_OF_INSTALL}/api/auth/oauth2/authorize`,
      token_endpoint: `${URL_OF_INSTALL}/api/auth/oauth2/token`,
      registration_endpoint: `${URL_OF_INSTALL}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(body["grant_types_supported"]).toEqual(["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"]);
    expect(body["device_authorization_endpoint"]).toBe(`${URL_OF_INSTALL}/api/auth/device/code`);
    // The install introspects no token for a resource server, and its introspection route answers 404: the metadata names none.
    expect(Object.keys(body).filter((key) => key.startsWith("introspection_"))).toEqual([]);
    expect((await harness.handle(new Request(`${URL_OF_INSTALL}/api/auth/oauth2/introspect`, { method: "POST" }))).status).toBe(404);
  });

  it("issues access tokens for the MCP resource that live 600 seconds and name the approving user", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const claims = claimsOf(accessToken);
    expect(claims).toMatchObject({ iss: URL_OF_INSTALL, aud: MCP_RESOURCE, sub: ana.userId });
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(600);
  });

  it("accepts an access token it issued at /api/v1, for the user who approved the client", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const answer = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` });
    expect(answer.status).toBe(200);
    // The key is quoted, so the source-citation check does not take the name and its colon for a citation.
    expect(await answer.json()).toMatchObject({ "requests": [] });
  });

  it("accepts the same access token at /mcp, for the same user", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } }),
      }),
    );
    expect(answer.status).toBe(200);
  });

  it("answers a call to /mcp with a valid access token without any outbound call", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("an outbound call")));
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } }),
      }),
    );
    expect(answer.status).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("checks an access token without any outbound call, the first check after the keys are read included", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const fresh = harness.freshTokenCheck();
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("an outbound call")));
    const caller = await fresh(new Request(`${URL_OF_INSTALL}/api/v1/requests`, { headers: { authorization: `Bearer ${accessToken}` } }));
    expect(caller).toMatchObject({ kind: "oauth_token", userId: ana.userId });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refuses the client credentials grant with unsupported_grant_type", async () => {
    const client = await harness.registerClient();
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId }).toString(),
      }),
    );
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error?: string }).error).toBe("unsupported_grant_type");
  });
});

// The authorization server's endpoints have rate limits (agent-access: Tiehall is the authorization server for agent
// clients; decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (14); design.md, Technical
// decisions: T7). From one client address, the authorization endpoint and the revocation endpoint each take at most 30
// calls in any minute, counted over the past minute; the next gets 429 with Retry-After, changes nothing and is not
// counted. Another address is not refused for this one's calls, and an address that calls once every 50 seconds is
// never refused, however long it goes on. The token endpoint's limits are tested in device-flow.test.ts.
describe("the limits on the authorization and revocation endpoints from one address", () => {
  /** The authorization codes the install holds for the person, which no client has exchanged yet. */
  async function codesOf(person: SignedIn): Promise<number> {
    const { rows } = await harness.install.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sign_in_verifications WHERE value LIKE '%"type":"authorization_code"%' AND value LIKE $1`,
      [`%"userId":"${person.userId}"%`],
    );
    return rows[0]?.n ?? 0;
  }

  /** The person's browser asks the authorization endpoint for a code for the client, from this client address. */
  function authorizeFrom(address: string, client: AgentClient): Promise<Response> {
    return harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" }, { "x-forwarded-for": address });
  }

  /** The client gives up this token at the revocation endpoint (RFC 7009), from this client address. */
  function revokeFrom(address: string, client: AgentClient, token: string): Promise<Response> {
    return harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
        body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: client.clientId }).toString(),
      }),
    );
  }

  it("refuses the 31st authorization within a minute from an address with 429 and Retry-After, issuing no code, and not another address's", async () => {
    const address = "198.51.100.61";
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    for (let call = 1; call <= 30; call += 1) {
      const answer = await authorizeFrom(address, client);
      expect(answer.status, `call ${call}`).toBe(302);
      expect(new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code"), `call ${call}`).not.toBeNull();
      elapsedMs += 1_000;
    }
    const before = await codesOf(ana);
    const limited = await authorizeFrom(address, client);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(new URL(limited.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code")).toBeNull();
    expect(await codesOf(ana)).toBe(before);
    // Another address, in the same minute, is not refused for this one's calls.
    const elsewhere = await authorizeFrom("198.51.100.62", client);
    expect(elsewhere.status).toBe(302);
    expect(new URL(elsewhere.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code")).not.toBeNull();
  });

  it("refuses the 31st revocation within a minute from an address with 429 and Retry-After, revoking nothing, and not another address's", async () => {
    const address = "198.51.100.63";
    const { client, refreshToken } = await harness.tokens(ana, ["requests:read"]);
    for (let call = 1; call <= 30; call += 1) {
      expect((await revokeFrom(address, client, `not-a-token-${call}`)).status, `call ${call}`).not.toBe(429);
      elapsedMs += 1_000;
    }
    const limited = await revokeFrom(address, client, refreshToken ?? "");
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Another address, in the same minute, is not refused for this one's calls.
    expect((await revokeFrom("198.51.100.64", client, "not-a-token")).status).not.toBe(429);
    // The refused revocation changed nothing: the refresh token still refreshes.
    const refreshed = await harness.refresh(client, refreshToken ?? "");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body["access_token"]).toEqual(expect.any(String));
  });

  it("never refuses an address that calls each endpoint once every 50 seconds, for as long as it calls", async () => {
    const address = "198.51.100.65";
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    for (let call = 1; call <= 40; call += 1) {
      expect((await authorizeFrom(address, client)).status, `authorization ${call}`).toBe(302);
      expect((await revokeFrom(address, client, "not-a-token")).status, `revocation ${call}`).not.toBe(429);
      elapsedMs += 50_000;
    }
  });
});
