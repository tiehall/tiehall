import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID, storedDeviceCode } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { hiddenField, MCP_RESOURCE, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// The device approval page cannot be prefilled (agent-access: The device
// approval page cannot be prefilled; agent-access: The CLI signs in through a
// restricted device flow; agent-safety: Actions that need the confirmation
// step; activity-log: Which actions are security events; design.md, Design
// rules: Agent access; design.md, Self-hosting decisions: S2, S7 and S14).
// When `tiehall login` prints a code, the person opens the install's device
// approval page, /device, signed in as a member, and types the code: the page
// ignores any code its URL carries, so a link cannot bring a code of someone
// else's CLI to it. For a typed code, posted from the page with the session's
// CSRF token, it shows the IP address and the time of the request that started
// the flow, as the install saw them after its trusted proxies, with "continue
// only if you just ran tiehall login", and stores nothing. Approving is an
// action that needs the confirmation step: the page is its review, whose form
// posts to /confirm/agent_clients.approve_device with a nonce bound to the
// member, their session and that code. A confirmed approval binds the code to
// the member and stores the CLI's grant with its security event; the CLI's
// next poll gets its tokens. An expired code gets 409, and the review page of
// the approval is never served from a URL: /confirm/agent_clients.approve_device
// sends the browser to /device.
// device-approval-browser.test.ts runs the same flow in a real browser.

let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** `tiehall login`'s device authorization request, from this address. */
async function login(address = "198.51.100.7"): Promise<{ deviceCode: string; userCode: string }> {
  const answer = await harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, resource: MCP_RESOURCE, scope: "requests:read requests:write" }).toString(),
    }),
  );
  const body = (await answer.json()) as { device_code: string; user_code: string };
  return { deviceCode: body.device_code, userCode: body.user_code };
}

/** The CLI's poll with its device code. */
async function poll(deviceCode: string): Promise<Answer> {
  // The CLI waits its interval between polls; the test lets it poll at once.
  await harness.install.owner.query("UPDATE oauth_device_codes SET last_polled_at = NULL WHERE device_code = $1", [storedDeviceCode(deviceCode)]);
  const answer = await harness.handle(
    new Request(`${URL_OF_INSTALL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLI_CLIENT_ID }).toString(),
    }),
  );
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

/** A hidden field's value on a page. */
function field(html: string, name: string): string {
  const value = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? "";
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Opens the device approval page as the person's browser does. */
function openPage(person: SignedIn, query = ""): Promise<Response> {
  return harness.handle(new Request(`${URL_OF_INSTALL}/device${query}`, { headers: { cookie: person.cookie, accept: "text/html" } }));
}

/** Types a code on the device approval page and posts it, as the page's form does from the install's own origin. */
async function typeCode(person: SignedIn, userCode: string, headers: Record<string, string> = {}): Promise<Response> {
  const page = await (await openPage(person)).text();
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/device`, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: new URLSearchParams({ user_code: userCode, csrf: field(page, "csrf") }).toString(),
    }),
  );
}

/** Posts the approval's review form, as its Confirm button does, with these fields over the page's own. */
async function confirm(person: SignedIn, review: string, fields: Record<string, string> = {}): Promise<Response> {
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve_device`, {
      method: "POST",
      headers: { cookie: person.cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ input: field(review, "input"), nonce: field(review, "nonce"), csrf: field(review, "csrf"), ...fields }).toString(),
    }),
  );
}

/** The device code's record as the install holds it. */
async function stored(deviceCode: string): Promise<{ status: string; user_id: string | null } | undefined> {
  const { rows } = await harness.install.owner.query("SELECT status, user_id FROM oauth_device_codes WHERE device_code = $1", [storedDeviceCode(deviceCode)]);
  return rows[0];
}

/** How many grants the CLI holds. */
async function cliGrants(): Promise<number> {
  const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_consents WHERE client_id = $1", [CLI_CLIENT_ID]);
  return rows[0].n;
}

describe("the device approval page", () => {
  it("sends a visitor without a session to sign in, and back to the page without any code", async () => {
    const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/device?user_code=ABCDEFGH`, { headers: { accept: "text/html" } }));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent("/device")}`);
  });

  it("is served only to a member: a person whose membership ended gets 403", async () => {
    const lee = await harness.member("lee-k");
    expect((await openPage(lee)).status).toBe(200);
    await harness.install.owner.query("DELETE FROM members WHERE user_id = $1", [lee.userId]);
    expect((await openPage(lee)).status).toBe(403);
  });

  it("leaves the code field empty when its link carries a code, and does not use that code", async () => {
    const { userCode } = await login();
    const answer = await openPage(ana, `?user_code=${userCode}&code=${userCode}`);
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain('<input type="text" id="user_code" name="user_code" value=""');
    expect(html).not.toContain(userCode);
    expect(html).not.toContain("198.51.100.7");
  });

  it("shows, for a typed code, the IP address and time of the request, and the text to continue only after tiehall login", async () => {
    const { deviceCode, userCode } = await login("203.0.113.44");
    const { rows } = await harness.install.owner.query("SELECT requested_at FROM oauth_device_codes WHERE device_code = $1", [storedDeviceCode(deviceCode)]);
    const requestedAt = (rows[0].requested_at as Date).toISOString().replace("T", " ").slice(0, 19);
    const answer = await typeCode(ana, userCode);
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain("203.0.113.44");
    expect(html).toContain(`${requestedAt} UTC`);
    expect(html).toContain("Continue only if you just ran tiehall login.");
    expect(html).toContain('action="/confirm/agent_clients.approve_device"');
    expect(html).not.toContain("Choose an org");
  });

  it("finds a code typed in lower case, with a dash and spaces", async () => {
    const { userCode } = await login();
    const typed = ` ${userCode.slice(0, 4).toLowerCase()}-${userCode.slice(4).toLowerCase()} `;
    const answer = await typeCode(ana, typed);
    expect(answer.status).toBe(200);
    expect(field(await answer.text(), "input")).toBe(JSON.stringify({ userCode }));
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (22): the code the CLI printed is
  // taken however it is typed, without a dash as with one.
  it("finds a code typed in lower case without its dash", async () => {
    const { userCode } = await login();
    const typed = userCode.replace(/-/g, "").toLowerCase();
    expect(typed).not.toContain("-");
    const answer = await typeCode(ana, typed);
    expect(answer.status).toBe(200);
    expect(field(await answer.text(), "input")).toBe(JSON.stringify({ userCode: userCode.replace(/-/g, "").toUpperCase() }));
  });

  it("stores nothing before the approval: the code stays pending and unbound, no grant exists, and the CLI gets no token", async () => {
    const { deviceCode, userCode } = await login();
    const grants = await cliGrants();
    const answer = await typeCode(ana, userCode);
    expect(answer.status).toBe(200);
    expect(await stored(deviceCode)).toEqual({ status: "pending", user_id: null });
    expect(await cliGrants()).toBe(grants);
    expect((await poll(deviceCode)).body["error"]).toBe("authorization_pending");
  });

  it("gets 404 for a code no sign-in is waiting with", async () => {
    const answer = await typeCode(ana, "ZZZZ-ZZZZ");
    expect(answer.status).toBe(404);
  });

  it("gets 409 for an expired code, and stores nothing", async () => {
    const { deviceCode, userCode } = await login();
    await harness.install.owner.query("UPDATE oauth_device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1", [storedDeviceCode(deviceCode)]);
    const answer = await typeCode(ana, userCode);
    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("expired");
    expect(await stored(deviceCode)).toEqual({ status: "pending", user_id: null });
  });

  it("refuses a typed code that was not posted from the page with 403", async () => {
    const { deviceCode, userCode } = await login();
    const answer = await typeCode(ana, userCode, { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" });
    expect(answer.status).toBe(403);
    expect(await stored(deviceCode)).toEqual({ status: "pending", user_id: null });
  });

  it("never reviews the approval from a URL: its review page's link sends the browser to the device approval page", async () => {
    const { userCode } = await login();
    const input = encodeURIComponent(JSON.stringify({ userCode }));
    const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve_device?input=${input}`, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/device");
  });
});

describe("approving a code", () => {
  it("without a valid confirmation gets 403, and the CLI gets no token", async () => {
    const { deviceCode, userCode } = await login();
    const review = await (await typeCode(ana, userCode)).text();
    const answer = await confirm(ana, review, { nonce: "" });
    expect(answer.status).toBe(403);
    expect(await stored(deviceCode)).toEqual({ status: "pending", user_id: null });
    expect((await poll(deviceCode)).body["error"]).toBe("authorization_pending");
  });

  it("with the confirmation step signs the CLI in for the approving member, stores its grant and records a security event", async () => {
    const { deviceCode, userCode } = await login();
    const review = await (await typeCode(ana, userCode)).text();
    const { rows: before } = await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events");
    const answer = await confirm(ana, review);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("Return to your terminal");
    expect(await stored(deviceCode)).toEqual({ status: "approved", user_id: ana.userId });
    const polled = await poll(deviceCode);
    expect(polled.status).toBe(200);
    const claims = JSON.parse(Buffer.from(String(polled.body["access_token"]).split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: ana.userId, aud: MCP_RESOURCE, azp: CLI_CLIENT_ID });
    const { rows } = await harness.install.owner.query(
      `SELECT e.type, e.class, e.actor_user_id,
              (SELECT c.client_id FROM oauth_clients c WHERE c.id::text = e.data->>'clientId') AS client,
              (SELECT g.user_id FROM oauth_consents g WHERE g.id::text = e.data->>'grantId') AS grant_user
         FROM events e WHERE e.number > $1`,
      [before[0].n],
    );
    expect(rows).toEqual([{ type: "agent_client.approved", class: "security", actor_user_id: ana.userId, client: CLI_CLIENT_ID, grant_user: ana.userId }]);
  });

  it("gets 409 once the code expired, even from a review page opened before", async () => {
    const { deviceCode, userCode } = await login();
    const review = await (await typeCode(ana, userCode)).text();
    await harness.install.owner.query("UPDATE oauth_device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1", [storedDeviceCode(deviceCode)]);
    const answer = await confirm(ana, review);
    expect(answer.status).toBe(409);
    expect(await stored(deviceCode)).toEqual({ status: "pending", user_id: null });
  });

  it("gets 409 for a code that was approved already, and the first approval stands", async () => {
    const { deviceCode, userCode } = await login();
    const first = await (await typeCode(ana, userCode)).text();
    const second = await (await typeCode(ana, userCode)).text();
    expect((await confirm(ana, first)).status).toBe(200);
    expect((await confirm(ana, second)).status).toBe(409);
    expect(await stored(deviceCode)).toEqual({ status: "approved", user_id: ana.userId });
  });
});

// Each member has one grant for the CLI (agent-access: The CLI signs in through a restricted device flow, its scenario
// "One CLI grant for every machine"; decisions-from-groups-15-28: design.md, Decisions this change rests on: D55
// (21)): every tiehall login the member approves, on any machine, updates that one grant, so revoking it on the
// Connected agents and tokens page signs the CLI out on every machine: each machine's refresh token gets invalid_grant.
describe("two approved logins of one member", () => {
  it("update one CLI grant, and revoking it refuses both machines' refresh tokens with invalid_grant", async () => {
    const dee = await harness.member("dee-k");
    const machines: string[] = [];
    for (const address of ["198.51.100.81", "198.51.100.82"]) {
      const { deviceCode, userCode } = await login(address);
      const review = await (await typeCode(dee, userCode)).text();
      expect((await confirm(dee, review)).status).toBe(200);
      const polled = await poll(deviceCode);
      expect(polled.status).toBe(200);
      machines.push(String(polled.body["refresh_token"]));
    }
    const { rows: grants } = await harness.install.owner.query("SELECT id FROM oauth_consents WHERE user_id = $1 AND client_id = $2", [dee.userId, CLI_CLIENT_ID]);
    expect(grants).toHaveLength(1);
    // Each machine's CLI refreshes its token, and keeps the refresh token that rotation gives it.
    const cli = { clientId: CLI_CLIENT_ID, redirectUri: "" };
    for (const [index, refreshToken] of machines.entries()) {
      const refreshed = await harness.refresh(cli, refreshToken);
      expect(refreshed.status, `machine ${index + 1}`).toBe(200);
      machines[index] = String(refreshed.body["refresh_token"]);
    }

    const tokensPage = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: dee.cookie, accept: "text/html" } }))).text();
    const revoked = await harness.handle(
      new Request(`${URL_OF_INSTALL}/tokens`, {
        method: "POST",
        headers: { cookie: dee.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ action: "revoke_grant", grant: String(grants[0]?.id), csrf: hiddenField(tokensPage, "csrf") }).toString(),
      }),
    );
    expect(revoked.status).toBe(303);

    for (const [index, refreshToken] of machines.entries()) {
      const refused = await harness.refresh(cli, refreshToken);
      expect(refused.status, `machine ${index + 1}`).toBe(400);
      expect(refused.body["error"], `machine ${index + 1}`).toBe("invalid_grant");
      expect(refused.body["access_token"]).toBeUndefined();
    }
  });
});
