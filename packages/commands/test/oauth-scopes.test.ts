import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addTeam, joinTeams, openRequestInTheWebUi } from "./support/requests.ts";

// OAuth scopes are coarse, and missing and insufficient tokens get standard
// challenges (agent-access: OAuth scopes are coarse; agent-access: Missing and
// insufficient tokens get standard challenges; agent-access: Credentials are
// accepted only in the Authorization header; design.md, Decisions this change
// rests on: D28 #48; design.md, Design rules: Agent access). The install
// offers exactly three scopes, requests:read, requests:write and
// contracts:report, and no admin scope: an authorization request that asks for
// any other is refused with invalid_scope, and one that asks for none gets
// requests:read and requests:write. Every grant brings a refresh token, which
// no client has to ask for. A token acts only within its scopes: a call to an
// operation that needs a scope the token lacks gets 403 insufficient_scope
// with the scope it needs, and runs nothing. Every challenge points to the
// protected resource metadata.

const METADATA = `${URL_OF_INSTALL}/.well-known/oauth-protected-resource/mcp`;

let harness: AgentAccessHarness;
let ana: SignedIn;
let fe142: string;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  await addTeam(harness.install.owner, "FE");
  const be = await addTeam(harness.install.owner, "BE");
  await joinTeams(harness.install.owner, ana.userId, be);
  const opened = await openRequestInTheWebUi<{ key: string }>(harness.install, ana.userId, { targetTeam: "FE", requestingTeam: "BE" });
  fe142 = opened.key;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function locationOf(answer: Response): URL {
  return new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
}

/** How many messages the request with this key, FE and its number, holds. */
async function messagesOn(key: string): Promise<number> {
  const { rows } = await harness.install.owner.query(
    `SELECT count(*) FROM messages m
       JOIN requests r ON r.org_id = m.org_id AND r.id = m.request_id
       JOIN teams t ON t.org_id = r.org_id AND t.id = r.target_team_id
      WHERE t.key || '-' || r.number = $1`,
    [key],
  );
  return Number(rows[0].count);
}

describe("the scopes the install offers", () => {
  it("are exactly requests:read, requests:write and contracts:report, in both metadata documents", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = (await (await harness.handle(new Request(`${URL_OF_INSTALL}${path}`))).json()) as { scopes_supported?: string[] };
      expect(body.scopes_supported, path).toEqual(["requests:read", "requests:write", "contracts:report"]);
    }
  });

  it.each(["requests:read admin", "admin", "offline_access", "requests:read openid"])("refuses an authorization request for %s with invalid_scope, and issues no code", async (scope) => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read", "requests:write", "contracts:report"]);
    const location = locationOf(await harness.authorize(ana.cookie, client, pkcePair(), { scope }));
    expect(`${location.origin}${location.pathname}`).toBe(client.redirectUri);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("iss")).toBe(URL_OF_INSTALL);
  });

  it("grants requests:read and requests:write to a request that names no scope, with a refresh token", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read", "requests:write"]);
    const pkce = pkcePair();
    const code = locationOf(await harness.authorize(ana.cookie, client, pkce, { scope: undefined })).searchParams.get("code") ?? "";
    const exchanged = await harness.exchange(client, code, pkce);
    expect(exchanged.status).toBe(200);
    const claims = JSON.parse(Buffer.from(String(exchanged.body["access_token"]).split(".")[1] ?? "", "base64url").toString("utf8")) as { scope: string };
    expect(claims.scope.split(" ").filter((scope) => scope.includes(":")).sort()).toEqual(["requests:read", "requests:write"]);
    expect(exchanged.body["refresh_token"]).toBeTypeOf("string");
  });

  it("gives a refresh token to a client that asks only for the scopes it needs", async () => {
    const { refreshToken } = await harness.tokens(ana, ["requests:read"]);
    expect(refreshToken).toBeTypeOf("string");
  });

  it("refuses a registration that asks for the admin scope with invalid_scope", async () => {
    const answer = await harness.register({ scope: "requests:read admin" });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error?: string }).error).toBe("invalid_scope");
  });
});

describe("a token acts only within its scopes", () => {
  it("refuses a message from a token with only requests:read with 403 insufficient_scope naming requests:write, and posts nothing", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    const before = await messagesOn(fe142);
    const answer = await harness.api("POST", `/api/v1/requests/${fe142}/messages`, { authorization: `Bearer ${accessToken}` }, { kind: "comment", body: "Any news?" });
    expect(answer.status).toBe(403);
    expect(answer.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", scope="requests:write", resource_metadata="${METADATA}"`);
    expect(((await answer.json()) as { type?: string }).type).toBe("https://tiehall.com/problems/insufficient-scope");
    expect(await messagesOn(fe142)).toBe(before);
  });

  it("lets the same person's token with requests:write post it", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read", "requests:write"]);
    const before = await messagesOn(fe142);
    const answer = await harness.api("POST", `/api/v1/requests/${fe142}/messages`, { authorization: `Bearer ${accessToken}` }, { kind: "comment", body: "Any news?" });
    expect(answer.status).toBe(200);
    expect(await messagesOn(fe142)).toBe(before + 1);
  });

  it("answers a call without a token with 401, pointing to the resource metadata with the operation's scope as the hint", async () => {
    const read = await harness.api("GET", `/api/v1/requests/${fe142}`);
    expect(read.status).toBe(401);
    expect(read.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}", scope="requests:read"`);
    const write = await harness.api("POST", `/api/v1/requests/${fe142}/messages`, {}, { kind: "comment", body: "Any news?" });
    expect(write.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}", scope="requests:write"`);
  });

  it("answers a token that is not valid with 401 invalid_token, pointing to the resource metadata", async () => {
    const answer = await harness.api("GET", `/api/v1/requests/${fe142}`, { authorization: "Bearer not.a.token" });
    expect(answer.status).toBe(401);
    expect(answer.headers.get("www-authenticate")).toBe(`Bearer error="invalid_token", resource_metadata="${METADATA}"`);
  });

  it("takes a token only from the Authorization header: in a cookie or another header it names no one", async () => {
    const { accessToken } = await harness.tokens(ana, ["requests:read"]);
    for (const headers of [{ cookie: `access_token=${accessToken}` }, { "x-access-token": accessToken }, { authorization: `Token ${accessToken}` }]) {
      const answer = await harness.api("GET", `/api/v1/requests/${fe142}`, headers);
      expect(answer.status, JSON.stringify(Object.keys(headers))).toBe(401);
    }
  });
});
