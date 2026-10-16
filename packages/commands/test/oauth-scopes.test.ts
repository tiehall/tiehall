import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { URL_OF_INSTALL } from "./support/install.ts";
import { hiddenField, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addTeam, joinTeams, openRequestInTheWebUi } from "./support/requests.ts";

// OAuth scopes are coarse, and missing and insufficient tokens get standard
// challenges (agent-access: OAuth scopes are coarse; agent-access: Missing and
// insufficient tokens get standard challenges; agent-access: Credentials are
// accepted only in the Authorization header; design.md, Decisions this change
// rests on: D28 #48; design.md, Design rules: Agent access). The install
// offers exactly three scopes, requests:read, requests:write and
// contracts:report, and no admin scope: an authorization request that asks for
// any other is refused with invalid_scope, except offline_access, which is
// ignored, and one that asks for none gets requests:read and requests:write.
// Every grant brings a refresh token, which no client has to ask for. A token acts only within its scopes: a call to an
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

/** The claims a signed access token carries, read without checking its signature. */
function claimsOf(token: string): { scope: string } & Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { scope: string } & Record<string, unknown>;
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
  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (13), as the maintainer answered on
  // 2026-10-16 (task 27.7). An agent client asks for the scopes it learns from the install: MCP's authorization rules
  // have it ask for the challenge's scope and, when it has none, for the protected resource's scopes_supported, and
  // Codex asked for every value listed, so its grant held contracts:report (the client-matrix log, 2026-10-15, F7). Both
  // metadata documents list only the two scopes an agent needs; contracts:report stays offered to a client that names it.
  it("are named as requests:read and requests:write alone in both metadata documents, where an agent client learns the scopes to ask for", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = (await (await harness.handle(new Request(`${URL_OF_INSTALL}${path}`))).json()) as { scopes_supported?: string[] };
      expect(body.scopes_supported, path).toEqual(["requests:read", "requests:write"]);
    }
  });

  it("still grant contracts:report to a request that names it, as Codex's did, once the person approves the consent screen that shows it", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const consent = locationOf(await harness.authorize(ana.cookie, client, pkce, { scope: "requests:read requests:write contracts:report" }));
    expect(consent.pathname).toBe("/consent");
    const html = await (await harness.handle(new Request(consent, { headers: { cookie: ana.cookie, accept: "text/html" } }))).text();
    expect(html).toContain("contracts:report: attach classified contract changes to a request");
    const confirmed = await harness.handle(
      new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
        body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
      }),
    );
    expect(confirmed.status).toBe(303);
    const back = await harness.handle(new Request(locationOf(confirmed), { headers: { cookie: ana.cookie, accept: "text/html" } }));
    const exchanged = await harness.exchange(client, locationOf(back).searchParams.get("code") ?? "", pkce);
    expect(exchanged.status).toBe(200);
    const token = String(exchanged.body["access_token"]);
    expect(claimsOf(token).scope.split(" ").sort()).toEqual(["contracts:report", "requests:read", "requests:write"]);
    // Attaching contract changes needs the scope: this token passes that check, while one without it is refused with
    // 403 insufficient_scope naming it, from which a client can sign in again with it.
    const attach = (accessToken: string) => harness.api("POST", `/api/v1/requests/${fe142}/contract-changes`, { authorization: `Bearer ${accessToken}`, "if-match": '"1"' }, { contract: {} });
    const withScope = await attach(token);
    expect(withScope.status).not.toBe(403);
    expect(withScope.headers.get("www-authenticate") ?? "").not.toContain("insufficient_scope");
    const { accessToken: without } = await harness.tokens(ana, ["requests:read", "requests:write"]);
    const refused = await attach(without);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", scope="contracts:report", resource_metadata="${METADATA}"`);
  });

  it("still name contracts:report in a registration's answer, among the scopes the client may ask for", async () => {
    const answer = await harness.register();
    expect(answer.status).toBe(201);
    const { scope } = (await answer.json()) as { scope?: string };
    expect((scope ?? "").split(" ")).toEqual(expect.arrayContaining(["requests:read", "requests:write", "contracts:report"]));
  });

  it("still grant the CLI the three scopes it asks for, contracts:report included, for tiehall contract diff --attach", async () => {
    const { accessToken } = await harness.signInCli(ana, ["requests:read", "requests:write", "contracts:report"]);
    expect(claimsOf(accessToken).scope.split(" ").sort()).toEqual(["contracts:report", "requests:read", "requests:write"]);
  });

  it.each(["requests:read admin", "admin", "requests:read openid", "admin offline_access"])("refuses an authorization request for %s with invalid_scope, and issues no code", async (scope) => {
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

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (13): the default is shown to the
  // person before they approve it, and never holds contracts:report, which a client must name to get.
  it("shows requests:read and requests:write on the consent screen to a request that names no scope, and its token has no contracts:report", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const consent = locationOf(await harness.authorize(ana.cookie, client, pkce, { scope: undefined }));
    expect(consent.pathname).toBe("/consent");
    const page = await harness.handle(new Request(consent, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("requests:read: read the install");
    expect(html).toContain("requests:write: open requests");
    expect(html).not.toContain("contracts:report");
    const action = /<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(action).toBe("/confirm/agent_clients.approve");
    const confirmed = await harness.handle(
      new Request(`${URL_OF_INSTALL}${action}`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
        body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
      }),
    );
    expect(confirmed.status).toBe(303);
    const answer = await harness.handle(new Request(locationOf(confirmed), { headers: { cookie: ana.cookie, accept: "text/html" } }));
    const code = locationOf(answer).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const exchanged = await harness.exchange(client, code, pkce);
    expect(exchanged.status).toBe(200);
    const claims = JSON.parse(Buffer.from(String(exchanged.body["access_token"]).split(".")[1] ?? "", "base64url").toString("utf8")) as { scope: string };
    const scopes = claims.scope.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["requests:read", "requests:write"]));
    expect(scopes).not.toContain("contracts:report");
    const { rows } = await harness.install.owner.query("SELECT scopes FROM oauth_consents WHERE user_id = $1 AND client_id = $2", [ana.userId, client.clientId]);
    expect(rows[0]?.scopes).not.toContain("contracts:report");
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (12) and (13); Technical decisions:
  // T4. Clients built for OpenID-style servers ask for offline_access to get a refresh token, which every grant brings
  // here anyway: the scope is ignored, never listed in scopes_supported, never shown on the consent screen and never
  // among the scopes of the token's answer; a request that names it alone gets the default scopes.
  it("ignores offline_access: requests:read offline_access is approved as requests:read alone, with a refresh token", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const consent = locationOf(await harness.authorize(ana.cookie, client, pkce, { scope: "requests:read offline_access" }));
    expect(consent.pathname).toBe("/consent");
    const page = await harness.handle(new Request(consent, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("requests:read: read the install");
    expect(html).not.toContain("requests:write");
    expect(html).not.toContain("offline_access");
    const confirmed = await harness.handle(
      new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
        body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
      }),
    );
    expect(confirmed.status).toBe(303);
    const answer = await harness.handle(new Request(locationOf(confirmed), { headers: { cookie: ana.cookie, accept: "text/html" } }));
    const code = locationOf(answer).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const exchanged = await harness.exchange(client, code, pkce);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body["scope"]).toBe("requests:read");
    expect(exchanged.body["refresh_token"]).toBeTypeOf("string");
    // offline_access is among none of the token's scopes, the signed token's own scope claim included.
    expect(claimsOf(String(exchanged.body["access_token"])).scope).toBe("requests:read");
    // The token reads requests and writes none.
    const reads = await harness.api("GET", "/api/v1/inbox", { authorization: `Bearer ${String(exchanged.body["access_token"])}` });
    expect(reads.status).toBe(200);
    // A refresh keeps the scopes and brings a new refresh token, which offline_access stays out of.
    const refreshed = await harness.refresh(client, String(exchanged.body["refresh_token"]));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body["scope"]).toBe("requests:read");
    expect(refreshed.body["refresh_token"]).toBeTypeOf("string");
    expect(claimsOf(String(refreshed.body["access_token"])).scope).toBe("requests:read");
    const readsAgain = await harness.api("GET", "/api/v1/inbox", { authorization: `Bearer ${String(refreshed.body["access_token"])}` });
    expect(readsAgain.status).toBe(200);
    // And the refreshed grant still refreshes.
    const again = await harness.refresh(client, String(refreshed.body["refresh_token"]));
    expect(again.status).toBe(200);
    expect(again.body["refresh_token"]).toBeTypeOf("string");
    expect(claimsOf(String(again.body["access_token"])).scope).toBe("requests:read");
  });

  it("gives a request that names only offline_access the default scopes, requests:read and requests:write", async () => {
    const client = await harness.registerClient();
    await harness.approve(ana.userId, client.clientId, ["requests:read", "requests:write"]);
    const pkce = pkcePair();
    const code = locationOf(await harness.authorize(ana.cookie, client, pkce, { scope: "offline_access" })).searchParams.get("code") ?? "";
    const exchanged = await harness.exchange(client, code, pkce);
    expect(exchanged.status).toBe(200);
    expect(String(exchanged.body["scope"]).split(" ").sort()).toEqual(["requests:read", "requests:write"]);
    expect(exchanged.body["refresh_token"]).toBeTypeOf("string");
    expect(claimsOf(String(exchanged.body["access_token"])).scope.split(" ").sort()).toEqual(["requests:read", "requests:write"]);
  });

  it("does not list offline_access in scopes_supported", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = (await (await harness.handle(new Request(`${URL_OF_INSTALL}${path}`))).json()) as { scopes_supported?: string[] };
      expect(body.scopes_supported, path).not.toContain("offline_access");
    }
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
