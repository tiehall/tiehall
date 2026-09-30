import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// Tiehall is the authorization server for agent clients (agent-access: Tiehall
// is the authorization server for agent clients; design.md, Design rules:
// Agent access; design.md, Technical decisions: T7 and T9; design.md,
// Self-hosting decisions: S13). The sign-in service is the install's own
// OAuth 2.1 authorization server, with the install's URL, TIEHALL_URL, as its
// issuer: it publishes the protected resource metadata of the install's MCP
// resource, which names the install as its authorization server, and the
// authorization server metadata, which offers the authorization code grant
// with refresh tokens and never the client credentials grant. Its access
// tokens are JWTs that live 600 seconds, signed with the install's own keys,
// and /api/v1 accepts them. Checking one reads the install's signing keys in
// the same process, so it makes no outbound call.

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
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

  it("publishes the authorization server metadata, with the install's URL as issuer, the authorization code and refresh token grants only, and S256", async () => {
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
    expect(body["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
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
