import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// One conformance test per OAuth rule of the install's authorization server,
// against /api/v1 (agent-access: Authorization requests use PKCE S256,
// resource indicators and the iss parameter; agent-access: Missing and
// insufficient tokens get standard challenges; agent-access: Credentials are
// accepted only in the Authorization header; agent-access: Access tokens live
// 10 minutes and refresh tokens rotate; design.md, Design rules: Agent access;
// design.md, Technical decisions: T7 and T9). An agent client registers, the
// signed-in person has approved it, and the client runs the authorization
// code flow with PKCE and the install's MCP resource, then calls /api/v1 with
// the access token. The cases waited as expected failures until the tasks that
// build each rule turned them into plain tests. The same rules hold on /mcp,
// whose cases joined when the MCP endpoint was built (16.2): a client calls it
// as MCP clients do, with a JSON-RPC request in a POST.

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** Where an authorization answer sends the browser. */
function locationOf(answer: Response): URL {
  return new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
}

/** A JWT's claims, as the token carries them. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

/** An access token in the install's form whose signature no key of the install made. */
function forgedToken(userId: string): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid: randomUUID() })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, aud: MCP_RESOURCE, iss: URL_OF_INSTALL, iat: now, exp: now + 600, scope: "requests:read", azp: "forged" }),
  ).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("Authorization requests use PKCE S256, resource indicators and the iss parameter", () => {
  it("refuses an authorization request with no code_challenge with invalid_request, and issues no code", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { code_challenge: undefined, code_challenge_method: undefined, scope: "requests:read" });
    const location = locationOf(answer);
    expect(`${location.origin}${location.pathname}`).toBe(client.redirectUri);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses the plain PKCE method with invalid_request, and issues no code", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const pkce = pkcePair();
    const answer = await harness.authorize(ana.cookie, client, pkce, { code_challenge: pkce.verifier, code_challenge_method: "plain", scope: "requests:read" });
    const location = locationOf(answer);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("binds the access token's audience to the resource it was asked for, and /api/v1 accepts it", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    expect(claimsOf(accessToken)["aud"]).toBe(MCP_RESOURCE);
    const answer = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` });
    expect(answer.status).toBe(200);
  });

  it("puts iss, equal to the issuer of the authorization server metadata, in the authorization response", async () => {
    const metadata = (await (await harness.handle(new Request(`${URL_OF_INSTALL}/.well-known/oauth-authorization-server`))).json()) as { issuer?: string };
    expect(metadata.issuer).toBe(URL_OF_INSTALL);
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    const location = locationOf(answer);
    expect(location.searchParams.get("code")).not.toBeNull();
    expect(location.searchParams.get("iss")).toBe(metadata.issuer);
  });
});

describe("Missing and insufficient tokens get standard challenges", () => {
  it("answers a call without a token with 401 and a challenge that points to the protected resource metadata and carries a scope hint", async () => {
    const answer = await harness.api("GET", "/api/v1/requests");
    expect(answer.status).toBe(401);
    const challenge = answer.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${URL_OF_INSTALL}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="requests:read"');
  });

  it("answers a token whose signature does not verify with 401 and invalid_token", async () => {
    const answer = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${forgedToken(ana.userId)}` });
    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers a token without the scope the operation needs with 403 insufficient_scope naming that scope, and runs nothing", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const before = Number((await harness.install.owner.query("SELECT count(*) FROM events")).rows[0].count);
    const answer = await harness.api("POST", "/api/v1/requests", { authorization: `Bearer ${accessToken}` }, { title: "Add a dark mode", targetTeam: "FE" });
    expect(answer.status).toBe(403);
    const challenge = answer.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="requests:write"');
    expect(Number((await harness.install.owner.query("SELECT count(*) FROM events")).rows[0].count)).toBe(before);
  });
});

describe("Credentials are accepted only in the Authorization header", () => {
  it("ignores a valid token in the query string: the call answers 401", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const accepted = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` });
    expect(accepted.status).toBe(200);
    const answer = await harness.api("GET", `/api/v1/requests?access_token=${encodeURIComponent(accessToken)}`);
    expect(answer.status).toBe(401);
  });
});

describe("Access tokens live 10 minutes and refresh tokens rotate", () => {
  it("refuses an access token issued 11 minutes earlier with 401", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const claims = claimsOf(accessToken);
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(600);
    expect((await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` })).status).toBe(200);
    harness.clock.advance(11 * 60 * 1000);
    try {
      const answer = await harness.api("GET", "/api/v1/requests", { authorization: `Bearer ${accessToken}` });
      expect(answer.status).toBe(401);
      expect(answer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    } finally {
      harness.clock.advance(-11 * 60 * 1000);
    }
  });

  it("rotates the refresh token on each use and refuses a used one with invalid_grant", async () => {
    const { client, refreshToken } = await harness.tokens(ana, ["requests:read"]);
    expect(refreshToken).toBeTypeOf("string");
    const first = await harness.refresh(client, refreshToken ?? "");
    expect(first.status).toBe(200);
    expect(first.body["refresh_token"]).toBeTypeOf("string");
    expect(first.body["refresh_token"]).not.toBe(refreshToken);
    const again = await harness.refresh(client, refreshToken ?? "");
    expect(again.status).toBe(400);
    expect(again.body["error"]).toBe("invalid_grant");
  });
});

/** A JSON-RPC request to /mcp, as a 2025-11-25 client opens its connection, with these headers. */
function initialize(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`${URL_OF_INSTALL}/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "conformance", version: "0.0.0" } },
    }),
  });
}

/** A tools/call to /mcp with these headers. */
function toolCall(name: string, args: Record<string, unknown>, headers: Record<string, string>): Request {
  return new Request(`${URL_OF_INSTALL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
}

describe("the same rules on /mcp", () => {
  it("accepts a valid access token", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const answer = await harness.handle(initialize({ authorization: `Bearer ${accessToken}` }));
    expect(answer.status).toBe(200);
  });

  it("answers a call without a token with 401 and a challenge that points to the protected resource metadata and carries a scope hint", async () => {
    const answer = await harness.handle(initialize());
    expect(answer.status).toBe(401);
    const challenge = answer.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${URL_OF_INSTALL}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="requests:read requests:write"');
    expect(answer.headers.get("content-type")).toBe("application/problem+json");
  });

  it("answers a token whose signature does not verify with 401 and invalid_token", async () => {
    const answer = await harness.handle(initialize({ authorization: `Bearer ${forgedToken(ana.userId)}` }));
    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(answer.headers.get("www-authenticate")).toContain(`resource_metadata="${URL_OF_INSTALL}/.well-known/oauth-protected-resource/mcp"`);
  });

  // A tool call that needs a scope the token lacks is refused over HTTP before it runs, which 16.4 builds for the tools 16.3 registers.
  it.fails("answers a token without the scope a tool needs with 403 insufficient_scope naming that scope, and runs nothing", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const before = Number((await harness.install.owner.query("SELECT count(*) FROM events")).rows[0].count);
    const answer = await harness.handle(toolCall("claim", { key: "FE-1" }, { authorization: `Bearer ${accessToken}` }));
    expect(answer.status).toBe(403);
    const challenge = answer.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="requests:write"');
    expect(Number((await harness.install.owner.query("SELECT count(*) FROM events")).rows[0].count)).toBe(before);
  });

  it("ignores a valid token in the query string: the call answers 401", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const answer = await harness.handle(initialize({}, `?access_token=${encodeURIComponent(accessToken)}`));
    expect(answer.status).toBe(401);
  });

  it("refuses an access token issued 11 minutes earlier with 401", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    expect((await harness.handle(initialize({ authorization: `Bearer ${accessToken}` }))).status).toBe(200);
    harness.clock.advance(11 * 60 * 1000);
    try {
      const answer = await harness.handle(initialize({ authorization: `Bearer ${accessToken}` }));
      expect(answer.status).toBe(401);
      expect(answer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    } finally {
      harness.clock.advance(-11 * 60 * 1000);
    }
  });
});
