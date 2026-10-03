import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTokenCheck } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { MCP_RESOURCE, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// Authorization requests use PKCE S256, resource indicators and the iss
// parameter (agent-access: Authorization requests use PKCE S256, resource
// indicators and the iss parameter; design.md, Design rules: Agent access;
// design.md, Technical decisions: T7). Beside the conformance cases
// (oauth-conformance.test.ts): PKCE is required of every client, a
// confidential one included; the resource an authorization request names must
// be the install's, and binds the code and the token to it; the token check
// accepts a token only for that resource, whatever key signed it; and every
// answer the authorization endpoint sends back to the client, a refusal
// included, names the issuer.

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function locationOf(answer: Response): URL {
  return new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
}

describe("an authorization request", () => {
  it("needs PKCE from a confidential client too: without a code challenge it gets invalid_request, with the issuer", async () => {
    const registered = await harness.register({
      application_type: "web",
      token_endpoint_auth_method: "client_secret_basic",
      redirect_uris: ["https://agent.vendor.example/callback"],
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const client = { clientId, redirectUri: "https://agent.vendor.example/callback" };
    await harness.approve(ana.userId, clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { code_challenge: undefined, code_challenge_method: undefined, scope: "requests:read" });
    const location = locationOf(answer);
    expect(`${location.origin}${location.pathname}`).toBe(client.redirectUri);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("iss")).toBe(URL_OF_INSTALL);
  });

  it("refuses a code challenge without its method, rather than assuming one", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { code_challenge_method: undefined, scope: "requests:read" });
    expect(locationOf(answer).searchParams.get("error")).toBe("invalid_request");
    expect(locationOf(answer).searchParams.get("code")).toBeNull();
  });

  it("refuses a resource that is not the install's with invalid_target, names the issuer, and issues no code", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { resource: "https://elsewhere.example/api", scope: "requests:read" });
    const location = locationOf(answer);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("iss")).toBe(URL_OF_INSTALL);
  });

  it("binds the code to its PKCE verifier: another verifier is refused, gets no token and uses the code up", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read"]);
    const pkce = pkcePair();
    const answer = await harness.authorize(ana.cookie, client, pkce, { scope: "requests:read" });
    const code = locationOf(answer).searchParams.get("code") ?? "";
    const exchanged = await harness.exchange(client, code, { ...pkce, verifier: pkcePair().verifier });
    // A verifier that does not match the code's challenge is an invalid grant, as RFC 7636 (4.6) and OAuth 2.1 have it:
    // 400 invalid_grant, which the sign-in library answers with 401 invalid_request unless Tiehall maps it.
    expect(exchanged.status).toBe(400);
    expect(exchanged.body["error"]).toBe("invalid_grant");
    expect(exchanged.body["access_token"]).toBeUndefined();
    // The refused exchange used the code up: the right verifier gets no token with it either.
    const again = await harness.exchange(client, code, pkce);
    expect(again.status).toBe(400);
    expect(again.body["error"]).toBe("invalid_grant");
  });
});

describe("the check of an access token", () => {
  let key: KeyObject;
  let kid: string;
  const check = () =>
    createAgentTokenCheck({
      url: URL_OF_INSTALL,
      signingKeys: async () => ({ keys: [{ ...(key.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "EdDSA" }] }),
    });

  beforeAll(() => {
    const pair = generateKeyPairSync("ed25519");
    key = pair.publicKey;
    kid = randomUUID();
    signer = pair.privateKey;
  });
  let signer: KeyObject;

  function tokenFor(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: ana.userId, iss: URL_OF_INSTALL, iat: now, exp: now + 600, scope: "requests:read", azp: "client-1", ...claims }),
    ).toString("base64url");
    return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), signer).toString("base64url")}`;
  }

  const request = (token: string) => new Request(`${URL_OF_INSTALL}/api/v1/requests`, { headers: { authorization: `Bearer ${token}` } });

  it("accepts a token for the install's MCP resource", async () => {
    expect(await check()(request(tokenFor({ aud: MCP_RESOURCE })))).toMatchObject({ kind: "oauth_token", userId: ana.userId, clientId: "client-1" });
  });

  it.each([
    { name: "another resource", aud: "https://elsewhere.example/api" },
    { name: "the install's URL itself", aud: URL_OF_INSTALL },
    { name: "no audience at all", aud: undefined },
  ])("refuses a token for $name with invalid_token, though the install's key signed it", async ({ aud }) => {
    await expect(check()(request(tokenFor({ aud })))).rejects.toMatchObject({ reason: "invalid-token", status: 401 });
  });

  it("refuses a token bound to a DPoP key, which /api/v1 takes only as a bearer token, with invalid_token", async () => {
    await expect(check()(request(tokenFor({ aud: MCP_RESOURCE, cnf: { jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" } })))).rejects.toMatchObject({
      reason: "invalid-token",
    });
  });

  it("refuses a token from another issuer with invalid_token", async () => {
    await expect(check()(request(tokenFor({ aud: MCP_RESOURCE, iss: "https://tiehall.other.example" })))).rejects.toMatchObject({ reason: "invalid-token" });
  });
});
