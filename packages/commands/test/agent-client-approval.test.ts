import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { pkcePair, startAgentAccess, type AgentAccessHarness, type AgentClient, type Pkce, type SignedIn } from "./support/agent-access.ts";

// Approving an agent client uses the confirmation step (agent-access:
// Approving an agent client uses the confirmation step; agent-safety: Actions
// that need the confirmation step; activity-log: Which actions are security
// events; activity-log: Writes the sign-in service owns are still recorded;
// design.md, Design rules: Agent access; design.md, Technical decisions: T8;
// design.md, Self-hosting decisions: S7 and S14). The consent screen is the
// approval's review page: its form carries a confirmation nonce bound to the
// signed-in member, their web session and this one approval, and posts to the
// confirmation step. Only a confirmed approval stores the grant, for the
// approving member, together with its security event, and sends the browser
// back to the authorization, which then gives the client its code. Without a
// valid confirmation the approval is refused with 403, and no code or token
// is issued; the sign-in service's own consent route is not served at all.
// Revoking the grant later is a security event too, and stops its refresh
// tokens at once.

let harness: AgentAccessHarness;
let ana: SignedIn;
let bob: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  bob = await harness.member("bob");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** The consent screen's form, as a member's browser gets it for a client's authorization request. */
interface ConsentForm {
  action: string;
  fields: { input: string; nonce: string; csrf: string };
}

function hidden(html: string, name: string): string {
  return (new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "").replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  );
}

/** Starts an authorization for the client as this member and opens the consent screen it leads to. */
async function consentFor(person: SignedIn, client: AgentClient, pkce: Pkce): Promise<ConsentForm> {
  const started = await harness.authorize(person.cookie, client, pkce, { scope: "requests:read requests:write" });
  const consent = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL);
  expect(consent.pathname).toBe("/consent");
  const page = await harness.handle(new Request(consent, { headers: { cookie: person.cookie, accept: "text/html" } }));
  expect(page.status).toBe(200);
  const html = await page.text();
  const action = /<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? "";
  return { action, fields: { input: hidden(html, "input"), nonce: hidden(html, "nonce"), csrf: hidden(html, "csrf") } };
}

/** Posts the consent screen's form, as the member's browser does from the install's own page. */
function post(person: SignedIn, form: ConsentForm, fields: Record<string, string> = { ...form.fields }, headers: Record<string, string> = {}): Promise<Response> {
  return harness.handle(
    new Request(`${URL_OF_INSTALL}${form.action}`, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
        accept: "text/html",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function grantsOf(userId: string): Promise<{ id: string; client_id: string; scopes: string[] }[]> {
  return (await harness.install.owner.query("SELECT id, client_id, scopes FROM oauth_consents WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
}

/** Where the authorization sends the browser now, as the member's browser follows it. */
async function authorizationNow(person: SignedIn, client: AgentClient, pkce: Pkce): Promise<URL> {
  const answer = await harness.authorize(person.cookie, client, pkce, { scope: "requests:read requests:write" });
  return new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
}

describe("the consent screen", () => {
  it("is the approval's review page: its form posts to the confirmation step with a nonce and the session's CSRF token", async () => {
    const client = await harness.registerClient();
    const form = await consentFor(ana, client, pkcePair());
    expect(form.action).toBe("/confirm/agent_clients.approve");
    expect(form.fields.nonce).not.toBe("");
    expect(form.fields.csrf).toBe(csrfTokenFor(harness.install.authSecret, (await harness.signIn.service.session(new Headers({ cookie: ana.cookie })))?.sessionId ?? ""));
    expect(JSON.parse(form.fields.input)).toMatchObject({ authorization: expect.stringContaining(`client_id=${client.clientId}`) });
  });
});

describe("an approval without a valid confirmation", () => {
  it("gets 403 with the session and the CSRF token alone, stores no grant, and issues no code", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const form = await consentFor(ana, client, pkce);
    const refused = await post(ana, form, { ...form.fields, nonce: "" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("https://tiehall.com/problems/confirmation-required");
    expect((await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId)).toEqual([]);
    const location = await authorizationNow(ana, client, pkce);
    expect(location.pathname).toBe("/consent");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("gets 403 with the nonce of another client's approval, or another member's, and stores no grant", async () => {
    const client = await harness.registerClient();
    const other = await harness.registerClient();
    const form = await consentFor(ana, client, pkcePair());
    const otherForm = await consentFor(ana, other, pkcePair());
    expect((await post(ana, form, { ...form.fields, nonce: otherForm.fields.nonce })).status).toBe(403);
    const bobs = await consentFor(bob, client, pkcePair());
    expect((await post(ana, form, { ...form.fields, nonce: bobs.fields.nonce })).status).toBe(403);
    expect((await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId)).toEqual([]);
  });

  it("gets 404 on the sign-in service's own consent route, with the session cookie and the signed request, and issues no code", async () => {
    const client = await harness.registerClient();
    const started = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    const signed = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL).search.slice(1);
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/json", origin: URL_OF_INSTALL },
        body: JSON.stringify({ accept: true, oauth_query: signed }),
      }),
    );
    expect(answer.status).toBe(404);
    expect(answer.headers.get("location")).toBeNull();
    expect((await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId)).toEqual([]);
  });
});

describe("a confirmed approval", () => {
  it("stores the grant for the approving member, sends the browser back to the authorization, and the client gets its code and a token for that member", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const form = await consentFor(ana, client, pkce);
    const confirmed = await post(ana, form);
    expect(confirmed.status).toBe(303);
    const back = new URL(confirmed.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(back.origin).toBe(URL_OF_INSTALL);
    expect(back.pathname).toBe("/api/auth/oauth2/authorize");
    expect(await grantsOf(ana.userId)).toContainEqual({ id: expect.any(String), client_id: client.clientId, scopes: ["requests:read", "requests:write", "offline_access"] });
    // The browser follows the redirect: the authorization gives the client its code, with the state and the issuer.
    const answer = await harness.handle(new Request(back, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    const location = new URL(answer.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(client.redirectUri);
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(URL_OF_INSTALL);
    const exchanged = await harness.exchange(client, location.searchParams.get("code") ?? "", pkce);
    expect(exchanged.status).toBe(200);
    const claims = JSON.parse(Buffer.from(String(exchanged.body["access_token"]).split(".")[1] ?? "", "base64url").toString("utf8")) as { sub: string };
    expect(claims.sub).toBe(ana.userId);
  });

  it("works for a native client that returns to another port of the loopback address it registered", async () => {
    const registered = await harness.registerClient({ redirect_uris: ["http://127.0.0.1/callback"] });
    const client = { clientId: registered.clientId, redirectUri: "http://127.0.0.1:61234/callback" };
    const pkce = pkcePair();
    const form = await consentFor(ana, client, pkce);
    const confirmed = await post(ana, form);
    expect(confirmed.status).toBe(303);
    const answer = await harness.handle(new Request(new URL(confirmed.headers.get("location") ?? "", URL_OF_INSTALL), { headers: { cookie: ana.cookie } }));
    const location = new URL(answer.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("http://127.0.0.1:61234/callback");
    expect(location.searchParams.get("code")).not.toBeNull();
  });

  it("is used once: posting the same form again gets 403", async () => {
    const client = await harness.registerClient();
    const form = await consentFor(ana, client, pkcePair());
    expect((await post(ana, form)).status).toBe(303);
    expect((await post(ana, form)).status).toBe(403);
  });

  it("is a security event naming the member and the client, with the address and user agent kept apart", async () => {
    const client = await harness.registerClient();
    const form = await consentFor(ana, client, pkcePair());
    const before = Number((await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    expect((await post(ana, form, form.fields, { "x-forwarded-for": "198.51.100.23", "user-agent": "Mozilla/5.0 (ana)" })).status).toBe(303);
    const [grant] = (await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId);
    const { rows: clients } = await harness.install.owner.query("SELECT id FROM oauth_clients WHERE client_id = $1", [client.clientId]);
    const { rows } = await harness.install.owner.query(
      `SELECT e.type, e.class, e.data, e.actor_kind, e.actor_user_id, e.surface, host(o.ip_address) AS ip, o.user_agent
         FROM events e LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
        WHERE e.number > $1 ORDER BY e.number`,
      [before],
    );
    expect(rows).toEqual([
      {
        type: "agent_client.approved",
        class: "security",
        data: { userId: ana.userId, clientId: clients[0].id, grantId: grant?.id },
        actor_kind: "web_session",
        actor_user_id: ana.userId,
        surface: "web",
        ip: "198.51.100.23",
        user_agent: "Mozilla/5.0 (ana)",
      },
    ]);
  });
});

describe("a later revocation of the grant", () => {
  it("is a security event, removes the grant and stops its refresh token at once", async () => {
    const { client, refreshToken } = await harness.tokens(ana, ["requests:read"]);
    const [grant] = (await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId);
    const session = await harness.signIn.service.session(new Headers({ cookie: ana.cookie }));
    if (session === undefined) throw new Error("Ana is not signed in.");
    const before = Number((await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events")).rows[0].n);
    const revoked = await harness.install.web(session).write("agent_grants.revoke", { grantId: grant?.id }, harness.install.fromThePage(session));
    expect(revoked).toEqual({ ok: true, output: { grantId: grant?.id } });
    expect((await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId)).toEqual([]);
    const { rows: clients } = await harness.install.owner.query("SELECT id FROM oauth_clients WHERE client_id = $1", [client.clientId]);
    const { rows } = await harness.install.owner.query("SELECT type, class, data, actor_user_id FROM events WHERE number > $1 ORDER BY number", [before]);
    expect(rows).toEqual([{ type: "agent_grant.revoked", class: "security", data: { userId: ana.userId, clientId: clients[0].id, grantId: grant?.id }, actor_user_id: ana.userId }]);
    const refreshed = await harness.refresh(client, refreshToken ?? "");
    expect(refreshed.status).toBe(400);
    expect(refreshed.body["error"]).toBe("invalid_grant");
  });

  it("is refused for another member's grant with 404, which leaves it", async () => {
    const { client } = await harness.tokens(ana, ["requests:read"]);
    const [grant] = (await grantsOf(ana.userId)).filter(({ client_id }) => client_id === client.clientId);
    const session = await harness.signIn.service.session(new Headers({ cookie: bob.cookie }));
    if (session === undefined) throw new Error("Bob is not signed in.");
    const refused = await harness.install.web(session).write("agent_grants.revoke", { grantId: grant?.id }, harness.install.fromThePage(session));
    expect(refused).toMatchObject({ ok: false, problem: { status: 404 } });
    expect((await grantsOf(ana.userId)).map(({ id }) => id)).toContain(grant?.id);
  });
});
