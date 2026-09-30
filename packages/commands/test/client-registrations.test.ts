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

  it("with a NUL character in any of its texts, which no text Tiehall stores may hold, gets 400 invalid_client_metadata and stores no client", async () => {
    const before = await clientCount();
    for (const metadata of [{ client_name: "agent\u0000one" }, { redirect_uris: ["http://127.0.0.1:33418/call\u0000back"] }, { contacts: ["ops\u0000@vendor.example"] }]) {
      const answer = await harness.register(metadata);
      expect(answer.status, JSON.stringify(metadata)).toBe(400);
      expect(((await answer.json()) as { error?: string }).error).toBe("invalid_client_metadata");
    }
    expect(await clientCount()).toBe(before);
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
