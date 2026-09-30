import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSessionCaller } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { hiddenField, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addUser } from "./support/members.ts";
import { sessionOf } from "./support/requests.ts";

// Personal access tokens are scoped, expiring and created in the web UI
// (agent-access: Personal access tokens are scoped, expiring and created in
// the web UI; agent-access: Six kinds of caller; activity-log: Which actions
// are security events; agent-safety: Actions that need the confirmation step;
// design.md, Design rules: Agent access; design.md, Self-hosting decisions: S7
// and S14). A member creates one on their Connected agents and tokens page,
// /tokens: its form names a label, the scopes and how many days the token
// lives, and leads to the review page of personal_access_tokens.create, where
// the member confirms it. The confirmation's page shows the token's value,
// which starts with th_pat_, this once; Tiehall keeps only its SHA-256 digest,
// and records a security event. A lifetime beyond 90 days, or beyond the
// shorter maximum an admin set, gets 400. No agent surface offers the command:
// a token's call to it gets 404, and a confirmation without a valid nonce 403.
// A call to /api/v1 with the value acts for the member, within its scopes.
//
// An admin sets the longest lifetime in the web UI with the confirmation step.

let harness: AgentAccessHarness;
let ana: SignedIn;
let ada: WebSessionCaller;

beforeAll(async () => {
  harness = await startAgentAccess();
  ana = await harness.member("ana-k");
  ada = sessionOf(await addUser(harness.install.owner, { role: "admin", login: "ada" }));
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** An admin sets the install's longest PAT lifetime in the web UI, with the confirmation step. */
async function maxLifetime(days: number): Promise<void> {
  const answer = await harness.install.confirm(ada, "settings.set_personal_access_token_max_lifetime", { maxLifetimeDays: days });
  if (answer.status !== 200) throw new Error(`the change's confirmation answered ${answer.status}: ${await answer.text()}`);
}

/** How many personal access tokens the install holds. */
async function tokenCount(): Promise<number> {
  const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM personal_access_tokens");
  return rows[0].n;
}

/** The review page of a new token with this input, as the person's browser opens it. */
function reviewPage(person: SignedIn, input: unknown): Promise<Response> {
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/confirm/personal_access_tokens.create?input=${encodeURIComponent(JSON.stringify(input))}`, {
      headers: { cookie: person.cookie, accept: "application/json" },
    }),
  );
}

/** Posts a review page's Confirm form, with these fields over the page's own. */
function confirm(person: SignedIn, review: string, fields: Record<string, string> = {}): Promise<Response> {
  return harness.handle(
    new Request(`${URL_OF_INSTALL}/confirm/personal_access_tokens.create`, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        origin: URL_OF_INSTALL,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ input: hiddenField(review, "input"), nonce: hiddenField(review, "nonce"), csrf: hiddenField(review, "csrf"), ...fields }).toString(),
    }),
  );
}

/** Every table whose rows hold this text anywhere. */
async function tablesHolding(text: string): Promise<string[]> {
  const { owner } = harness.install;
  const { rows: tables } = await owner.query<{ schema: string; name: string }>(
    "SELECT schemaname AS schema, tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
  );
  const holding: string[] = [];
  for (const { schema, name } of tables) {
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ${JSON.stringify(schema)}.${JSON.stringify(name)} t WHERE t::text LIKE '%' || $1 || '%'`, [text]);
    if (rows[0].n > 0) holding.push(`${schema}.${name}`);
  }
  return holding;
}

describe("the Connected agents and tokens page", () => {
  it("sends a visitor without a session to sign in, and back to the page", async () => {
    const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { accept: "text/html" } }));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent("/tokens")}`);
  });

  it("holds the form that creates a token, which names the install's longest lifetime", async () => {
    const answer = await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(answer.status).toBe(200);
    const html = await answer.text();
    expect(html).toContain("Create a personal access token");
    expect(html).toContain("Days until it expires, at most 90");
    for (const scope of ["requests:read", "requests:write", "contracts:report"]) expect(html).toContain(`name="scope" value="${scope}"`);
  });

  it("leads its form to the review page of exactly the token it names", async () => {
    const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie } }))).text();
    const form = new URLSearchParams({ name: "Nightly sync", expiresInDays: "14", csrf: hiddenField(page, "csrf") });
    form.append("scope", "requests:read");
    const answer = await harness.handle(
      new Request(`${URL_OF_INSTALL}/tokens`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: form.toString(),
      }),
    );
    expect(answer.status).toBe(303);
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.pathname).toBe("/confirm/personal_access_tokens.create");
    expect(JSON.parse(location.searchParams.get("input") ?? "")).toEqual({ name: "Nightly sync", scopes: ["requests:read"], expiresInDays: 14 });
  });
});

describe("creating a personal access token", () => {
  let token: string;
  let events: Record<string, unknown>[];

  beforeAll(async () => {
    const { rows } = await harness.install.owner.query("SELECT coalesce(max(number), 0) AS n FROM events");
    token = await harness.personalAccessToken(
      ana,
      { name: "Build script", scopes: ["requests:read"], expiresInDays: 30 },
      { "x-forwarded-for": "198.51.100.31", "user-agent": "Mozilla/5.0 (ana)" },
    );
    events = (
      await harness.install.owner.query(
        `SELECT e.type, e.class, e.actor_kind, e.actor_user_id, e.surface, e.data, host(o.ip_address) AS ip, o.user_agent
           FROM events e LEFT JOIN security_event_origins o ON o.org_id = e.org_id AND o.event_number = e.number
          WHERE e.number > $1 ORDER BY e.number`,
        [rows[0].n],
      )
    ).rows;
  });

  it("with the confirmation step gives a value that starts with th_pat_", () => {
    expect(token).toMatch(/^th_pat_[A-Za-z0-9_-]{43}$/);
  });

  it("keeps only a hash of the value: no table holds the value itself", async () => {
    const digest = createHash("sha256").update(token).digest("hex");
    const { rows } = await harness.install.owner.query(
      "SELECT user_id, name, scopes, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days, revoked_at FROM personal_access_tokens WHERE token_hash = $1",
      [digest],
    );
    expect(rows).toEqual([{ user_id: ana.userId, name: "Build script", scopes: ["requests:read"], days: 30, revoked_at: null }]);
    expect(await tablesHolding(token)).toEqual([]);
    expect(await tablesHolding(token.slice("th_pat_".length))).toEqual([]);
  });

  it("records a security event that names the member and the token, never the value", async () => {
    const { rows } = await harness.install.owner.query("SELECT id FROM personal_access_tokens WHERE user_id = $1 AND name = 'Build script'", [ana.userId]);
    expect(events).toEqual([
      {
        type: "personal_access_token.created",
        class: "security",
        actor_kind: "web_session",
        actor_user_id: ana.userId,
        surface: "web",
        data: { userId: ana.userId, tokenId: rows[0].id },
        ip: "198.51.100.31",
        user_agent: "Mozilla/5.0 (ana)",
      },
    ]);
  });

  it("shows the value on no later page: the Connected agents and tokens page and another token's review page do not hold it", async () => {
    const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie } }))).text();
    expect(page).not.toContain(token);
    const review = await (await reviewPage(ana, { name: "Another", scopes: ["requests:read"], expiresInDays: 1 })).text();
    expect(review).not.toContain(token);
  });

  it("acts for its member on /api/v1, within its scopes", async () => {
    const read = await harness.api("GET", "/api/v1/requests", bearer(token));
    expect(read.status).toBe(200);
    const write = await harness.api("POST", "/api/v1/requests", bearer(token), {});
    expect(write.status).toBe(403);
    expect(((await write.json()) as { type: string }).type).toBe("https://tiehall.com/problems/insufficient-scope");
  });

  it("gets 401 invalid_token for a value no token has, and for an expired token", async () => {
    const unknown = await harness.api("GET", "/api/v1/requests", bearer(`${token.slice(0, -2)}xy`));
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const expiring = await harness.personalAccessToken(ana, { name: "Short-lived", expiresInDays: 1 });
    await harness.install.owner.query("UPDATE personal_access_tokens SET created_at = created_at - interval '2 days', expires_at = now() - interval '1 second' WHERE name = 'Short-lived'");
    const expired = await harness.api("GET", "/api/v1/requests", bearer(expiring));
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("a token's lifetime", () => {
  it("above 90 days is refused with 400, and nothing is created", async () => {
    const before = await tokenCount();
    const answer = await reviewPage(ana, { name: "Too long", scopes: ["requests:read"], expiresInDays: 120 });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { type: string }).type).toBe("https://tiehall.com/problems/outside-settings");
    expect(await tokenCount()).toBe(before);
  });

  it("of 90 days is accepted in a new install", async () => {
    const token = await harness.personalAccessToken(ana, { name: "Quarterly", expiresInDays: 90 });
    expect(token.startsWith("th_pat_")).toBe(true);
  });

  it("above the admin's shorter maximum is refused with 400, even when the review page was opened before the admin shortened it", async () => {
    const before = await tokenCount();
    const review = await (
      await harness.handle(
        new Request(`${URL_OF_INSTALL}/confirm/personal_access_tokens.create?input=${encodeURIComponent(JSON.stringify({ name: "Six weeks", scopes: ["requests:read"], expiresInDays: 45 }))}`, {
          headers: { cookie: ana.cookie, accept: "text/html" },
        }),
      )
    ).text();
    await maxLifetime(30);
    try {
      const refused = await reviewPage(ana, { name: "Six weeks", scopes: ["requests:read"], expiresInDays: 45 });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { type: string }).type).toBe("https://tiehall.com/problems/outside-settings");
      const confirmed = await confirm(ana, review);
      expect(confirmed.status).toBe(400);
      expect(((await confirmed.json()) as { type: string }).type).toBe("https://tiehall.com/problems/outside-settings");
      expect(await tokenCount()).toBe(before);
      const page = await (await harness.handle(new Request(`${URL_OF_INSTALL}/tokens`, { headers: { cookie: ana.cookie } }))).text();
      expect(page).toContain("Days until it expires, at most 30");
    } finally {
      await maxLifetime(90);
    }
  });

  it("with no scope, or a scope Tiehall does not offer, is refused with 400", async () => {
    for (const scopes of [[], ["admin"]]) {
      const answer = await reviewPage(ana, { name: "No scope", scopes, expiresInDays: 10 });
      expect(answer.status, JSON.stringify(scopes)).toBe(400);
    }
  });
});

describe("a creation", () => {
  it("through a token gets 404 on /api/v1, whatever its scopes, and creates nothing", async () => {
    const before = await tokenCount();
    const { accessToken } = await harness.tokens(ana, ["requests:read", "requests:write", "contracts:report"]);
    const pat = await harness.personalAccessToken(ana, { name: "Every scope", scopes: ["requests:read", "requests:write", "contracts:report"] });
    const input = { name: "From an agent", scopes: ["requests:read"], expiresInDays: 10 };
    for (const token of [accessToken, pat]) {
      for (const path of ["/api/v1/personal-access-tokens", "/api/v1/personal_access_tokens.create", "/api/v1/tokens"]) {
        const answer = await harness.api("POST", path, bearer(token), input);
        expect(answer.status, path).toBe(404);
      }
    }
    expect(await tokenCount()).toBe(before + 1);
  });

  it("without a valid confirmation gets 403, and creates nothing", async () => {
    const before = await tokenCount();
    const review = await (
      await harness.handle(
        new Request(`${URL_OF_INSTALL}/confirm/personal_access_tokens.create?input=${encodeURIComponent(JSON.stringify({ name: "Unconfirmed", scopes: ["requests:read"], expiresInDays: 10 }))}`, {
          headers: { cookie: ana.cookie, accept: "text/html" },
        }),
      )
    ).text();
    for (const nonce of ["", "not-a-nonce"]) {
      const answer = await confirm(ana, review, { nonce });
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as { type: string }).type).toBe("https://tiehall.com/problems/confirmation-required");
    }
    expect(await tokenCount()).toBe(before);
  });
});
