import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAgentClient, removeUnusedAgentClients, withOrg } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// Dynamic Client Registration stays on, limited and unverified (agent-access:
// Dynamic Client Registration stays on, limited and unverified; design.md,
// Decisions this change rests on: D28 #43; design.md, Design rules: Agent
// access; design.md, Technical decisions: T6 and T7). Any agent client may
// register itself, but one address, as the install sees it after its trusted
// proxies, registers at most 10 clients in an hour: the 11th registration gets
// 429 with Retry-After, which says when the oldest of the ten leaves the hour,
// and no client id. A registered client that has never completed an
// authorization is removed 7 days after it registered, so its id is refused
// afterwards. A registered client's name is its own claim, and each
// installation of a client registers a new id, so every one is unverified;
// only a client identified by its metadata document has a verified host.
// The clock here is the test's.

let harness: AgentAccessHarness;
let ana: SignedIn;
let now = new Date("2026-10-01T09:00:00Z");

beforeAll(async () => {
  harness = await startAgentAccess({ clientMetadata: { now: () => now } });
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const at = (time: string) => {
  now = new Date(time);
};

async function clientCount(): Promise<number> {
  return Number((await harness.install.owner.query("SELECT count(*) FROM oauth_clients")).rows[0].count);
}

async function runRemoval(time: string): Promise<void> {
  await removeUnusedAgentClients.handle(
    { id: "remove", queue: removeUnusedAgentClients.type.queue, data: {}, signal: new AbortController().signal },
    { database: harness.install.db, now: () => new Date(time) },
  );
}

describe("registrations from one address", () => {
  it("are at most 10 an hour: the 11th gets 429 with Retry-After and no client id", async () => {
    at("2026-10-01T09:00:00Z");
    for (let index = 1; index <= 10; index += 1) {
      if (index === 6) at("2026-10-01T09:20:00Z");
      const answer = await harness.register({}, { "x-forwarded-for": "203.0.113.5" });
      expect(answer.status, `registration ${index}`).toBe(201);
    }
    const before = await clientCount();
    at("2026-10-01T09:59:00Z");
    const refused = await harness.register({}, { "x-forwarded-for": "203.0.113.5" });
    expect(refused.status).toBe(429);
    // The oldest of the ten leaves the hour at 10:00, a minute from now.
    expect(refused.headers.get("retry-after")).toBe("60");
    const body = (await refused.json()) as { type?: string; client_id?: string };
    expect(body.type).toBe("https://tiehall.com/problems/rate-limited");
    expect(body.client_id).toBeUndefined();
    expect(await clientCount()).toBe(before);
  });

  it("are counted per address: another address registers in the same hour", async () => {
    at("2026-10-01T09:59:30Z");
    expect((await harness.register({}, { "x-forwarded-for": "198.51.100.7" })).status).toBe(201);
    expect((await harness.register({}, { "x-forwarded-for": "203.0.113.5" })).status).toBe(429);
  });

  it("are taken again once the oldest of them has left the hour", async () => {
    at("2026-10-01T10:00:01Z");
    expect((await harness.register({}, { "x-forwarded-for": "203.0.113.5" })).status).toBe(201);
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (16): every registration that reaches
  // the endpoint counts toward the address's 10, one refused for its metadata included, so a prober cannot try
  // metadata without limit.
  it("count a registration refused for its redirect URI: after 9, one of them refused, the 10th is taken and the 11th gets 429", async () => {
    at("2026-10-01T11:00:00Z");
    const address = { "x-forwarded-for": "203.0.113.9" };
    for (let index = 1; index <= 9; index += 1) {
      if (index === 4) {
        const refused = await harness.register({ application_type: "web", redirect_uris: ["http://agent.vendor.example/callback"] }, address);
        expect(refused.status, `registration ${index}`).toBe(400);
        expect(((await refused.json()) as { client_id?: string }).client_id).toBeUndefined();
        continue;
      }
      expect((await harness.register({}, address)).status, `registration ${index}`).toBe(201);
    }
    expect((await harness.register({}, address)).status).toBe(201);
    const limited = await harness.register({}, address);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { type?: string }).type).toBe("https://tiehall.com/problems/rate-limited");
  });
});

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (24); Technical decisions: T4. One host
// commonly holds a whole IPv6 /64, so an IPv6 client is counted by its /64: every address in one /64 shares the 10
// registrations an hour, and an address in another /64 does not.
describe("registrations from IPv6 addresses", () => {
  it("share the 10 an hour within one /64, and another /64 registers", async () => {
    at("2026-10-01T12:00:00Z");
    for (let index = 1; index <= 10; index += 1) {
      const answer = await harness.register({}, { "x-forwarded-for": `2001:db8:1:2::${index.toString(16)}` });
      expect(answer.status, `registration ${index}`).toBe(201);
    }
    const refused = await harness.register({}, { "x-forwarded-for": "2001:db8:1:2:ffff:ffff:ffff:fffe" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await harness.register({}, { "x-forwarded-for": "2001:db8:1:3::5" })).status).toBe(201);
  });

  it("count an IPv4 address written as IPv6 by its IPv4 address alone", async () => {
    at("2026-10-01T13:00:00Z");
    for (let index = 1; index <= 10; index += 1) {
      expect((await harness.register({}, { "x-forwarded-for": "::ffff:192.0.2.10" })).status, `registration ${index}`).toBe(201);
    }
    expect((await harness.register({}, { "x-forwarded-for": "::ffff:192.0.2.10" })).status).toBe(429);
    expect((await harness.register({}, { "x-forwarded-for": "::ffff:192.0.2.11" })).status).toBe(201);
  });
});

describe("a registered client never used", () => {
  it("is removed 7 days after it registered, and its id is refused afterwards; a used one and a younger one stay", async () => {
    at("2026-10-02T12:00:00Z");
    const unused = await harness.registerClient();
    const used = await harness.registerClient();
    await harness.approve(ana.userId, used.clientId, ["requests:read"]);
    const pkce = pkcePair();
    const code = new URL((await harness.authorize(ana.cookie, used, pkce, { scope: "requests:read" })).headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect((await harness.exchange(used, code, pkce)).status).toBe(200);
    at("2026-10-05T12:00:00Z");
    const younger = await harness.registerClient();

    await runRemoval("2026-10-09T11:59:00Z");
    const remaining = async () =>
      (await harness.install.owner.query<{ client_id: string }>("SELECT client_id FROM oauth_clients")).rows.map(({ client_id }) => client_id);
    expect(await remaining()).toEqual(expect.arrayContaining([unused.clientId, used.clientId, younger.clientId]));

    await runRemoval("2026-10-09T12:01:00Z");
    expect(await remaining()).not.toContain(unused.clientId);
    expect(await remaining()).toEqual(expect.arrayContaining([used.clientId, younger.clientId]));

    const answer = await harness.authorize(ana.cookie, unused, pkcePair(), { scope: "requests:read" });
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.origin).toBe(URL_OF_INSTALL);
    expect(location.searchParams.get("error")).toBe("invalid_client");
    expect(location.searchParams.get("code")).toBeNull();
  });
});

describe("a registration", () => {
  it("of a client whose every redirect URI is on its own computer is a native client's, though it does not say so", async () => {
    at("2026-10-10T09:00:00Z");
    const answer = await harness.register({ application_type: undefined, redirect_uris: ["http://localhost:33418/callback", "http://127.0.0.1:33418/callback"] });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ application_type: "native" });
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (15): a native app's private scheme,
  // one that holds a dot (RFC 8252), shows a native client as a loopback address does.
  it("of a client whose one redirect URI has a native app's private scheme is a native client's, though it does not say so", async () => {
    const answer = await harness.register({ application_type: undefined, redirect_uris: ["com.example.app:/callback"] });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ application_type: "native", redirect_uris: ["com.example.app:/callback"] });
  });

  it("with a NUL character in any of its texts, which no text Tiehall stores may hold, gets 400 invalid_client_metadata and stores no client", async () => {
    const before = await clientCount();
    for (const metadata of [{ client_name: "agent\u0000one" }, { redirect_uris: ["http://127.0.0.1:33418/call\u0000back"] }, { contacts: ["ops\u0000@vendor.example"] }]) {
      const answer = await harness.register(metadata);
      expect(answer.status, JSON.stringify(metadata)).toBe(400);
      expect(((await answer.json()) as { error?: string }).error).toBe("invalid_client_metadata");
    }
    expect(await clientCount()).toBe(before);
  });

  // decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (25); Technical decisions: T4. A
  // client's name has 1 to 100 characters, and a client at most 10 redirect URIs of at most 2,048 characters each; a
  // registration outside these bounds is refused with 400 invalid_client_metadata, never a 500, and still counts.
  it("outside its metadata's bounds gets 400 invalid_client_metadata, stores no client, and counts", async () => {
    at("2026-10-10T10:00:00Z");
    const address = { "x-forwarded-for": "203.0.113.77" };
    const before = await clientCount();
    const tooLong = `http://127.0.0.1:33418/${"a".repeat(2049 - "http://127.0.0.1:33418/".length)}`;
    expect(tooLong).toHaveLength(2049);
    for (const metadata of [
      { client_name: "a".repeat(101) },
      { client_name: "" },
      { redirect_uris: Array.from({ length: 11 }, (_, index) => `http://127.0.0.1:${33_400 + index}/callback`) },
      { redirect_uris: [tooLong] },
    ]) {
      const answer = await harness.register(metadata, address);
      expect(answer.status, JSON.stringify(metadata).slice(0, 80)).toBe(400);
      expect(((await answer.json()) as { error?: string }).error).toBe("invalid_client_metadata");
    }
    expect(await clientCount()).toBe(before);
    const { rows } = await harness.install.owner.query("SELECT count(*)::int AS n FROM oauth_client_registrations WHERE host(ip_address) = '203.0.113.77'");
    expect(rows[0].n).toBe(4);
  });

  it("at its metadata's bounds is taken: a name of 100 characters, and 10 redirect URIs of up to 2,048 characters", async () => {
    at("2026-10-10T11:00:00Z");
    const longest = `http://127.0.0.1:33418/${"a".repeat(2048 - "http://127.0.0.1:33418/".length)}`;
    const answer = await harness.register(
      { client_name: "a".repeat(100), redirect_uris: [longest, ...Array.from({ length: 9 }, (_, index) => `http://127.0.0.1:${33_400 + index}/callback`)] },
      { "x-forwarded-for": "203.0.113.78" },
    );
    expect(answer.status).toBe(201);
  });

  it("of a web client with an https redirect URI stays a web client's", async () => {
    const answer = await harness.register({ application_type: undefined, redirect_uris: ["https://agent.vendor.example/callback"] });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ application_type: "web" });
  });
});

// decisions-from-groups-15-28: design.md, Decisions this change rests on: D55 (15), as the maintainer answered on
// 2026-10-15, after the install refused Cursor's registration (docs/client-matrix/log.md; task 27.5): a native app's
// own scheme needs no dot, so Cursor's cursor: and the vscode: of clients built on VS Code count, as reverse-domain
// schemes do. A redirect URI has an app's own scheme only when it is written in printable ASCII with no space, holds no
// fragment and no user information, has a scheme that is none of the web's, of those a browser shows or runs itself
// and of those that reach a program by an address, and has a path, or // with a host and a path, after its scheme.
// PKCE stays required, and the consent screen names where the sign-in ends: the scheme and the whole URI.
describe("a native app's own scheme", () => {
  const CURSOR = "cursor://anysphere.cursor-mcp/oauth/callback";
  const VSCODE = "vscode://vendor.mcp-client/oauth/callback";
  // Cursor's registration as its MCP client sends it, with no application_type: Cursor's log names the redirect URI
  // and the refusal, and the other fields are those an MCP client registers a public client with.
  const CURSOR_REGISTRATION = {
    client_name: "Cursor",
    redirect_uris: [CURSOR],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  /** Sends a registration body exactly as written, with none of the harness's fields over it, from an address of its own. */
  function registerAsSent(body: Record<string, unknown>): Promise<Response> {
    return harness.handle(
      new Request(`${URL_OF_INSTALL}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.18.${randomInt(256)}.${randomInt(1, 255)}` },
        body: JSON.stringify(body),
      }),
    );
  }

  async function storedRedirects(clientId: string): Promise<string[]> {
    const { rows } = await harness.install.owner.query<{ redirect_uris: string[] }>("SELECT redirect_uris FROM oauth_clients WHERE client_id = $1", [clientId]);
    return rows[0]?.redirect_uris ?? [];
  }

  const locationOf = (answer: Response) => new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
  /** A URL without its query: for an app's scheme, whose origin is opaque, its scheme, host and path. */
  const withoutQuery = (url: URL) => `${url.protocol}//${url.host}${url.pathname}`;
  const decoded = (html: string) => html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

  it("of Cursor's registration, as Cursor sends it with no application_type, is a native client's, which gets a client id and keeps its redirect URI", async () => {
    at("2026-10-15T20:00:00Z");
    const answer = await registerAsSent(CURSOR_REGISTRATION);
    expect(answer.status).toBe(201);
    const body = (await answer.json()) as { client_id: string };
    expect(body).toMatchObject({ application_type: "native", redirect_uris: [CURSOR], token_endpoint_auth_method: "none" });
    expect(await storedRedirects(body.client_id)).toEqual([CURSOR]);
  });

  it.each([
    ["Cursor", CURSOR, "cursor:"],
    ["a client built on VS Code", VSCODE, "vscode:"],
  ])(
    "of %s: an authorization with it and PKCE reaches the consent screen, which names the scheme and the whole URI; one without PKCE is refused; the approved client gets its code there",
    async (name, redirectUri, scheme) => {
      const registered = await registerAsSent({ ...CURSOR_REGISTRATION, client_name: name, redirect_uris: [redirectUri] });
      expect(registered.status).toBe(201);
      const client = { clientId: ((await registered.json()) as { client_id: string }).client_id, redirectUri };

      const consent = locationOf(await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read requests:write" }));
      expect(consent.pathname).toBe("/consent");
      const page = await harness.handle(new Request(consent, { headers: { cookie: ana.cookie, accept: "text/html" } }));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' ${scheme};`);
      const html = decoded(await page.text());
      expect(html).toContain(`opens ${scheme} addresses, at ${redirectUri}.`);
      expect(html).not.toContain(`returns to ${new URL(redirectUri).host}`);
      expect(html).toMatch(/unverified client/i);

      const refused = locationOf(await harness.authorize(ana.cookie, client, pkcePair(), { code_challenge: undefined, code_challenge_method: undefined, scope: "requests:read" }));
      expect(withoutQuery(refused)).toBe(redirectUri);
      expect(refused.searchParams.get("error")).toBe("invalid_request");
      expect(refused.searchParams.get("code")).toBeNull();

      await harness.approve(ana.userId, client.clientId, ["requests:read", "requests:write"]);
      const pkce = pkcePair();
      const returned = locationOf(await harness.authorize(ana.cookie, client, pkce));
      expect(withoutQuery(returned)).toBe(redirectUri);
      expect(returned.searchParams.get("state")).toBe("state-1");
      expect(returned.searchParams.get("iss")).toBe(URL_OF_INSTALL);
      const exchanged = await harness.exchange(client, returned.searchParams.get("code") ?? "", pkce);
      expect(exchanged.status).toBe(200);
      expect(typeof exchanged.body["access_token"]).toBe("string");
    },
  );

  it("needs no dot in the path form, and may stand beside a loopback redirect URI, each kept in its place", async () => {
    const dotless = await registerAsSent({ ...CURSOR_REGISTRATION, redirect_uris: ["myapp:/oauth/callback"] });
    expect(dotless.status).toBe(201);
    expect(await dotless.json()).toMatchObject({ application_type: "native", redirect_uris: ["myapp:/oauth/callback"] });
    const both = await registerAsSent({ ...CURSOR_REGISTRATION, redirect_uris: ["http://127.0.0.1:33418/callback", CURSOR, VSCODE] });
    expect(both.status).toBe(201);
    const body = (await both.json()) as { client_id: string };
    expect(body).toMatchObject({ application_type: "native", redirect_uris: ["http://127.0.0.1:33418/callback", CURSOR, VSCODE] });
    expect(await storedRedirects(body.client_id)).toEqual(["http://127.0.0.1:33418/callback", CURSOR, VSCODE]);
  });

  it.each([
    // The web's schemes, those whose addresses a browser shows or runs itself, and those that reach a program by an
    // address, each in the shape an app's scheme has: the list alone refuses them.
    ...["http", "ws", "wss", "ftp", "file", "vbscript", "data", "blob", "about", "filesystem", "view-source", "mailto", "tel", "sms"].map((scheme) => [
      `${scheme}://agent.vendor.example/callback`,
    ]),
    ["javascript://agent.vendor.example/%0Aalert(1)"],
    ["JavaScript://agent.vendor.example/%0Aalert(1)"],
    // Shapes that are no app's own: no path, or no host after //, a path that does not begin with /, another URL
    // wrapped in the scheme, a fragment, user information, and characters a URL is not written with.
    ["cursor://anysphere.cursor-mcp"],
    ["cursor:///oauth/callback"],
    ["cursor:oauth/callback"],
    ["mailto:agent@vendor.example"],
    ["microsoft-edge:https://agent.vendor.example/callback"],
    [`${CURSOR}#done`],
    ["cursor://agent@anysphere.cursor-mcp/oauth/callback"],
    ["cursor://anysphere.cursor-mcp/oauth/call back"],
    ["cursor://anysphere.cursor-mcp/oauth/callb\u00e4ck"],
  ])("is never %s: a registration with it, with no type or as native, gets 400 invalid_redirect_uri and no client", async (uri) => {
    const before = await clientCount();
    for (const type of [{}, { application_type: "native" }]) {
      const answer = await registerAsSent({ ...CURSOR_REGISTRATION, ...type, redirect_uris: [uri] });
      expect(answer.status, JSON.stringify(type)).toBe(400);
      const body = (await answer.json()) as { error?: string; client_id?: string };
      expect(body.error, JSON.stringify(type)).toBe("invalid_redirect_uri");
      expect(body.client_id).toBeUndefined();
    }
    expect(await clientCount()).toBe(before);
  });

  it("beside an https redirect URI keeps the web type, and the registration is refused for the app's scheme; one that names native takes both", async () => {
    const before = await clientCount();
    const mixed = await registerAsSent({ ...CURSOR_REGISTRATION, redirect_uris: [CURSOR, "https://agent.vendor.example/callback"] });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect(await clientCount()).toBe(before);
    const native = await registerAsSent({ ...CURSOR_REGISTRATION, application_type: "native", redirect_uris: ["https://agent.vendor.example/callback", CURSOR] });
    expect(native.status).toBe(201);
    expect(await native.json()).toMatchObject({ application_type: "native", redirect_uris: ["https://agent.vendor.example/callback", CURSOR] });
  });

  // A registration whose last step fails after the sign-in library stored its client, as when the process stops in
  // between, leaves a client whose row kept the stand-in for its app's scheme, or, for a loopback client, its own
  // URIs, and no record of the registration that names it (decisions-from-groups-15-28: design.md, Technical
  // decisions: T4). Such a client was never used, so it is removed 7 days after it registered, as any registered
  // client never used is; the CLI's client and a metadata-document client are no registered ones and stay. The test
  // makes the database refuse the step that records the registration's client id.
  it("left with its stand-in, by a registration whose last step failed, is removed 7 days after it registered, as a loopback client left so is; the CLI's client and a metadata-document client stay", async () => {
    const clientIds = async () =>
      (await harness.install.owner.query<{ client_id: string }>("SELECT client_id FROM oauth_clients")).rows.map(({ client_id }) => client_id);
    const before = new Set(await clientIds());
    await harness.install.owner.query(`
      CREATE OR REPLACE FUNCTION probe_refuse_registration_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'probe: the registration could not be recorded';
      END $$;
      CREATE TRIGGER probe_refuse_registration_record BEFORE UPDATE ON oauth_client_registrations FOR EACH ROW EXECUTE FUNCTION probe_refuse_registration_record();`);
    let failed: Response[];
    try {
      failed = [await registerAsSent(CURSOR_REGISTRATION), await registerAsSent({ ...CURSOR_REGISTRATION, redirect_uris: ["http://127.0.0.1:33418/callback"] })];
    } finally {
      await harness.install.owner.query("DROP TRIGGER probe_refuse_registration_record ON oauth_client_registrations; DROP FUNCTION probe_refuse_registration_record()");
    }
    expect(failed.map(({ status }) => status)).toEqual([500, 500]);

    const { rows: left } = await harness.install.owner.query<{ client_id: string; redirect_uris: string[]; created_at: Date; recorded: boolean }>(
      `SELECT client_id, redirect_uris, created_at,
              EXISTS (SELECT 1 FROM oauth_client_registrations r WHERE r.org_id = c.org_id AND r.client_id = c.client_id) AS recorded
         FROM oauth_clients c WHERE NOT (client_id = ANY($1)) ORDER BY created_at, client_id`,
      [[...before]],
    );
    expect(left).toHaveLength(2);
    expect(left.map(({ redirect_uris }) => redirect_uris)).toEqual(
      expect.arrayContaining([[expect.stringMatching(/^invalid\.tiehall\.redirect:\/[0-9a-f-]{36}$/)], ["http://127.0.0.1:33418/callback"]]),
    );
    expect(left.map(({ recorded }) => recorded)).toEqual([false, false]);
    const registeredAt = left.map(({ created_at }) => created_at.getTime());
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    // A metadata-document client and the CLI's client, both as old and never used.
    const metadataClient = "https://left.vendor.example/oauth/client.json";
    await harness.install.owner.query(
      `INSERT INTO oauth_clients (org_id, client_id, client_discovery_id, name, redirect_uris, token_endpoint_auth_method, created_at)
         SELECT id, $1, 'cimd', 'Vendor agent', ARRAY['http://127.0.0.1:53682/callback'], 'none', $2 FROM orgs`,
      [metadataClient, new Date(Math.min(...registeredAt))],
    );
    await harness.install.owner.query("UPDATE oauth_clients SET created_at = $1 WHERE client_id = 'tiehall-cli'", [new Date(Math.min(...registeredAt))]);
    const leftIds = left.map(({ client_id }) => client_id);

    await runRemoval(new Date(Math.min(...registeredAt) + sevenDays - 60_000).toISOString());
    expect(await clientIds()).toEqual(expect.arrayContaining(leftIds));

    await runRemoval(new Date(Math.max(...registeredAt) + sevenDays + 60_000).toISOString());
    const remaining = await clientIds();
    for (const clientId of leftIds) expect(remaining).not.toContain(clientId);
    expect(remaining).toEqual(expect.arrayContaining(["tiehall-cli", metadataClient]));
  });
});

describe("a registered client", () => {
  it("is labeled unverified, with no verified host; a metadata-document client has its document's host", async () => {
    const registered = await harness.registerClient({ client_name: "Claims to be Claude Code" });
    const metadataClient = "https://vendor.example/oauth/client.json";
    await harness.install.owner.query(
      `INSERT INTO oauth_clients (org_id, client_id, client_discovery_id, name, redirect_uris, token_endpoint_auth_method)
         SELECT id, $1, 'cimd', 'Vendor agent', ARRAY['http://127.0.0.1:53682/callback'], 'none' FROM orgs`,
      [metadataClient],
    );
    await withOrg(harness.install.db, async (context) => {
      expect(await readAgentClient(context, registered.clientId)).toMatchObject({
        clientId: registered.clientId,
        name: "Claims to be Claude Code",
        verifiedHost: undefined,
        unverified: true,
      });
      expect(await readAgentClient(context, metadataClient)).toMatchObject({ name: "Vendor agent", verifiedHost: "vendor.example", unverified: false });
      expect(await readAgentClient(context, "no-such-client")).toBeUndefined();
    });
  });
});

// An authorization the install cannot send back to its client, because the client is unknown or the address it names
// to return to is not one it registered, comes to the sign-in page with the OAuth error; the page answers it as every
// refusal to a browser is answered (Technical decisions: T5): a page in Tiehall's own words that names the error and
// leads home, not the sign-in form with a sign-in failure.
describe("an authorization that cannot go back to its client", () => {
  async function refusedAuthorization(parameters: Record<string, string>): Promise<{ location: URL; page: Response }> {
    const client = await harness.registerClient();
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read", ...parameters });
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    const page = await harness.handle(new Request(location, { headers: { accept: "text/html", cookie: ana.cookie } }));
    return { location, page };
  }

  it.each([
    ["an unknown client", { client_id: "no-such-client" }, "invalid_client", "is not registered with this install"],
    ["an address to return to the client did not register", { redirect_uri: "https://elsewhere.example/callback" }, "invalid_redirect", "an address to return to that it did not register"],
  ])("is answered, for %s, with a page that names the OAuth error in Tiehall's words and leads home", async (_case, parameters, error, words) => {
    const { location, page } = await refusedAuthorization(parameters);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toBe(error);
    expect(page.status).toBe(400);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const html = (await page.text()).replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    expect(html).toContain(words);
    expect(html).toContain(`(${error})`);
    expect(html).toContain('<a class="button" href="/">');
    expect(html).not.toContain('action="/sign-in"');
    expect(html).not.toContain("did not complete");
  });

  it("leaves a sign-in with GitHub that did not complete on the sign-in page, which says why", async () => {
    const page = await harness.handle(new Request(`${URL_OF_INSTALL}/sign-in?error=state_mismatch`, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/sign-in"');
  });
});
