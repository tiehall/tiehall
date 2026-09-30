import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPersonalAccessTokenSettingsRoute, type WebSessionCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";
import { startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// An admin sets the PAT switch and the maximum lifetime (agent-access: An
// admin sets the PAT switch and the maximum lifetime; agent-access: Every
// token call is checked against the install's current state; teams-and-roles:
// The role bounds every caller acting for a user; activity-log: Which actions
// are security events; design.md, Design rules: Agent access; design.md,
// Self-hosting decisions: S7 and S14). A new install allows personal access
// tokens of up to 90 days. Only an admin changes the switch or the longest
// lifetime, in the web UI, on the admin page /admin/personal-access-tokens,
// whose links and form lead to the review pages of the two changes, each with
// the confirmation step. Switching off makes every call with a PAT, an
// existing one included, get 403; switching on again lets unexpired ones work
// again. A member's change gets 403, and a maximum above 90 days gets 400.
// Each change is a security event.

let harness: AgentAccessHarness;
let ana: SignedIn;
let ada: WebSessionCaller;
let dana: WebSessionCaller;

const SWITCH = "settings.set_personal_access_tokens";
const MAX_LIFETIME = "settings.set_personal_access_token_max_lifetime";

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  ada = sessionOf(await addUser(harness.install.owner, { role: "admin", login: "ada" }));
  dana = sessionOf(await addUser(harness.install.owner, { role: "member", login: "dana" }));
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The install's PAT settings as stored: none until an admin first changes one. */
async function stored(): Promise<{ on: boolean; days: number } | undefined> {
  const { rows } = await harness.install.owner.query("SELECT personal_access_tokens_on AS on, personal_access_token_max_days AS days FROM install_settings");
  return rows[0];
}

/** The last event's number. */
async function lastEvent(): Promise<number> {
  const { rows } = await harness.install.owner.query("SELECT coalesce(max(number), 0)::int AS n FROM events");
  return rows[0].n;
}

/** The events after that number, with the client address and user agent kept apart. */
async function eventsSince(number: number): Promise<Record<string, unknown>[]> {
  const { rows } = await harness.install.owner.query(
    `SELECT e.type, e.class, e.actor_kind, e.actor_user_id, e.data, host(o.ip_address) AS ip, o.user_agent
       FROM events e LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
      WHERE e.number > $1 ORDER BY e.number`,
    [number],
  );
  return rows;
}

/** The admin page, for the caller's web session. */
function adminRoute(caller: WebSessionCaller): (request: Request) => Promise<Response> {
  const { install } = harness;
  return createPersonalAccessTokenSettingsRoute({ execute: install.execute, session: async () => caller, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });
}

/** The admin page, as the caller's browser opens it. */
function adminPage(caller: WebSessionCaller): Promise<Response> {
  return adminRoute(caller)(new Request(`${URL_OF_INSTALL}/admin/personal-access-tokens`, { headers: { accept: "text/html" } }));
}

/** The admin page's form, posted from the page by the caller's browser. */
function adminForm(caller: WebSessionCaller, fields: Record<string, string>): Promise<Response> {
  return adminRoute(caller)(
    new Request(`${URL_OF_INSTALL}/admin/personal-access-tokens`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ ...fields, csrf: harness.install.fromThePage(caller).csrfToken ?? "" }).toString(),
    }),
  );
}

/** Confirms a change on its review page as the caller, with a browser's address and user agent. */
function change(caller: WebSessionCaller, commandId: string, input: unknown): Promise<Response> {
  return harness.install.confirm(caller, commandId, input, { "x-forwarded-for": "198.51.100.40", "user-agent": "Mozilla/5.0 (admin)" });
}

describe("a new install", () => {
  it("allows personal access tokens of up to 90 days", async () => {
    expect(await stored()).toBeUndefined();
    const token = await harness.personalAccessToken(ana, { expiresInDays: 90 });
    expect((await harness.api("GET", "/api/v1/requests", bearer(token))).status).toBe(200);
    await expect(harness.personalAccessToken(ana, { expiresInDays: 91 })).rejects.toThrow(/answered 400/);
  });

  it("shows an admin the switch on and the longest lifetime of 90 days, with the ways to change them", async () => {
    const answer = await adminPage(ada);
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain("Personal access tokens are switched on.");
    expect(html).toContain("A new personal access token lives at most 90 days.");
    expect(html).toContain(`href="/confirm/${SWITCH}?input=${encodeURIComponent(JSON.stringify({ on: false }))}"`);
    expect(html).toContain('name="maxLifetimeDays"');
  });
});

describe("the PAT switch", () => {
  it("switched off by an admin with the confirmation step makes every existing PAT get 403, and switched on again restores unexpired ones", async () => {
    const lee = await harness.member("lee-k");
    const anaToken = await harness.personalAccessToken(ana, { name: "Ana's script" });
    const leeToken = await harness.personalAccessToken(lee, { name: "Lee's script" });
    const expiring = await harness.personalAccessToken(lee, { name: "Lee's old script", expiresInDays: 1 });
    await harness.install.owner.query("UPDATE personal_access_tokens SET created_at = created_at - interval '2 days', expires_at = now() - interval '1 second' WHERE name = $1", [
      "Lee's old script",
    ]);
    const from = await lastEvent();
    expect((await change(ada, SWITCH, { on: false })).status).toBe(200);
    expect((await stored())?.on).toBe(false);
    for (const token of [anaToken, leeToken]) {
      const answer = await harness.api("GET", "/api/v1/requests", bearer(token));
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as { type: string }).type).toBe("https://tiehall.com/problems/personal-access-tokens-off");
    }
    expect((await change(ada, SWITCH, { on: true })).status).toBe(200);
    for (const token of [anaToken, leeToken]) expect((await harness.api("GET", "/api/v1/requests", bearer(token))).status).toBe(200);
    expect((await harness.api("GET", "/api/v1/requests", bearer(expiring))).status).toBe(401);
    expect(await eventsSince(from)).toEqual([
      {
        type: "settings.personal_access_tokens_switched",
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ada.userId,
        data: { on: false, previousOn: true },
        ip: "198.51.100.40",
        user_agent: "Mozilla/5.0 (admin)",
      },
      {
        type: "settings.personal_access_tokens_switched",
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ada.userId,
        data: { on: true, previousOn: false },
        ip: "198.51.100.40",
        user_agent: "Mozilla/5.0 (admin)",
      },
    ]);
  });

  it("changed by a member gets 403, and stays on", async () => {
    const review = await harness.install.confirmRoute(dana)(new Request(`${URL_OF_INSTALL}/confirm/${SWITCH}?input=${encodeURIComponent(JSON.stringify({ on: false }))}`));
    expect(review.status).toBe(403);
    const from = await lastEvent();
    const answer = await harness.install.confirmRoute(dana)(
      new Request(`${URL_OF_INSTALL}/confirm/${SWITCH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ input: JSON.stringify({ on: false }), csrf: harness.install.fromThePage(dana).csrfToken ?? "" }).toString(),
      }),
    );
    expect(answer.status).toBe(403);
    expect((await stored())?.on).toBe(true);
    expect(await eventsSince(from)).toEqual([]);
  });

  it("set to what it is already changes nothing and records nothing", async () => {
    const from = await lastEvent();
    expect((await change(ada, SWITCH, { on: true })).status).toBe(200);
    expect(await eventsSince(from)).toEqual([]);
  });
});

describe("the longest lifetime", () => {
  it("set shorter by an admin with the confirmation step applies to new PATs, and is a security event", async () => {
    const from = await lastEvent();
    expect((await change(ada, MAX_LIFETIME, { maxLifetimeDays: 30 })).status).toBe(200);
    try {
      expect((await stored())?.days).toBe(30);
      await expect(harness.personalAccessToken(ana, { expiresInDays: 45 })).rejects.toThrow(/answered 400/);
      expect((await harness.personalAccessToken(ana, { expiresInDays: 30 })).startsWith("th_pat_")).toBe(true);
      const html = await (await adminPage(ada)).text();
      expect(html).toContain("A new personal access token lives at most 30 days.");
      expect((await eventsSince(from)).filter(({ type }) => String(type).startsWith("settings."))).toEqual([
        {
          type: "settings.personal_access_token_max_lifetime_changed",
          class: "security",
          actor_kind: "web_session",
          actor_user_id: ada.userId,
          data: { maxLifetimeDays: 30, previousMaxLifetimeDays: 90 },
          ip: "198.51.100.40",
          user_agent: "Mozilla/5.0 (admin)",
        },
      ]);
    } finally {
      expect((await change(ada, MAX_LIFETIME, { maxLifetimeDays: 90 })).status).toBe(200);
    }
  });

  it("above 90 days is refused with 400, and the maximum is unchanged", async () => {
    const before = (await stored())?.days;
    const from = await lastEvent();
    for (const maxLifetimeDays of [91, 120]) {
      const review = await harness.install.confirmRoute(ada)(
        new Request(`${URL_OF_INSTALL}/confirm/${MAX_LIFETIME}?input=${encodeURIComponent(JSON.stringify({ maxLifetimeDays }))}`),
      );
      expect(review.status).toBe(400);
      const answer = await harness.install.confirmRoute(ada)(
        new Request(`${URL_OF_INSTALL}/confirm/${MAX_LIFETIME}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
          body: new URLSearchParams({ input: JSON.stringify({ maxLifetimeDays }), csrf: harness.install.fromThePage(ada).csrfToken ?? "" }).toString(),
        }),
      );
      expect(answer.status).toBe(400);
    }
    expect((await stored())?.days).toBe(before);
    expect(await eventsSince(from)).toEqual([]);
  });

  it("changed by a member gets 403, and is unchanged", async () => {
    const review = await harness.install.confirmRoute(dana)(
      new Request(`${URL_OF_INSTALL}/confirm/${MAX_LIFETIME}?input=${encodeURIComponent(JSON.stringify({ maxLifetimeDays: 7 }))}`),
    );
    expect(review.status).toBe(403);
    expect((await stored())?.days).toBe(90);
  });
});

describe("the admin page", () => {
  it("gets 403 for a member, whose form changes nothing", async () => {
    expect((await adminPage(dana)).status).toBe(403);
    expect((await adminForm(dana, { maxLifetimeDays: "7" })).status).toBe(403);
  });

  it("leads an admin's form to the review page of the maximum it names", async () => {
    const answer = await adminForm(ada, { maxLifetimeDays: "14" });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/confirm/${MAX_LIFETIME}?input=${encodeURIComponent(JSON.stringify({ maxLifetimeDays: 14 }))}`);
  });
});
