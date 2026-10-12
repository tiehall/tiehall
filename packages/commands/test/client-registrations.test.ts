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
