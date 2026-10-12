import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutboundFetcher, type ConnectTarget } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { CLIENT_REDIRECT_URI, hiddenField, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";
import { addTeam, joinTeams, packetOf } from "./support/requests.ts";

// Clients identified by a Client ID Metadata Document are preferred
// (agent-access: Clients identified by a Client ID Metadata Document are
// preferred; agent-safety: Outbound fetches refuse internal addresses;
// design.md, Decisions this change rests on: D28 #43; design.md, Design rules:
// Agent access; design.md, Technical decisions: T7 and T14). A client whose
// client_id is an https URL is identified by the document at that URL, which
// the install fetches through its outbound fetcher: it resolves the host
// itself, refuses one on an internal address without connecting to it, and
// follows no redirect. The client counts as identified only when the
// document's client_id equals the URL exactly; the install then knows the
// client by that URL, and the authorization request goes on to the consent
// screen. At most 60 documents a minute are fetched from one host: an
// authorization request the install cannot check because its host's limit is
// used up gets 429 with Retry-After. The tests name hosts through a resolver
// of their own and route every connection to a local server, which serves the
// documents in plain HTTP.

const HOSTS: Readonly<Record<string, string>> = {
  "vendor.example": "93.184.215.14",
  "busy.example": "93.184.215.15",
  "quiet.example": "93.184.215.16",
  "ports.example": "93.184.215.17",
  "internal.vendor.example": "10.0.0.5",
};

let server: Server;
let port: number;
let fetched: string[];
let connections: ConnectTarget[];
let harness: AgentAccessHarness;
let ana: SignedIn;

/** A client's metadata document, as the MCP 2026-07-28 profile asks for it. */
function documentFor(clientId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: clientId,
    client_name: "Vendor agent",
    redirect_uris: [CLIENT_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    // The host as the client id names it, with its port when it names one.
    const host = request.headers.host ?? "";
    const url = `https://${host}${request.url ?? "/"}`;
    fetched.push(url);
    if (request.url === "/oauth/mismatched.json") {
      return response.writeHead(200, { "content-type": "application/json" }).end(documentFor("https://vendor.example/oauth/client.json"));
    }
    if (request.url === "/oauth/nul.json") {
      return response.writeHead(200, { "content-type": "application/json" }).end(documentFor(url, { client_name: "Vendor\u0000agent" }));
    }
    if (request.url === "/oauth/moved.json") return response.writeHead(302, { location: "https://vendor.example/oauth/client.json" }).end();
    if (request.url === "/oauth/long-name.json") {
      return response.writeHead(200, { "content-type": "application/json" }).end(documentFor(url, { client_name: "a".repeat(101) }));
    }
    if (request.url === "/oauth/many-redirects.json") {
      const redirects = Array.from({ length: 11 }, (_, index) => `http://127.0.0.1:${33_400 + index}/callback`);
      return response.writeHead(200, { "content-type": "application/json" }).end(documentFor(url, { redirect_uris: redirects }));
    }
    return response.writeHead(200, { "content-type": "application/json" }).end(documentFor(url));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  const fetchDocument = createOutboundFetcher({
    maxRedirects: 0,
    resolve: async (hostname) => (HOSTS[hostname] === undefined ? [] : [HOSTS[hostname]]),
    connect: (target) => {
      connections.push(target);
      return netConnect({ host: "127.0.0.1", port });
    },
  });
  harness = await startAgentAccess({ clientMetadata: { fetchDocument } });
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  fetched = [];
  connections = [];
});

/** Starts an authorization with a client id that is a URL, from its own client address, as a signed-in member's browser does. */
function authorizeAs(clientId: string, from = "198.51.100.1"): Promise<Response> {
  return harness.authorize(ana.cookie, { clientId, redirectUri: CLIENT_REDIRECT_URI }, pkcePair(), { scope: "requests:read" }, { "x-forwarded-for": from });
}

async function clientRow(clientId: string): Promise<{ client_discovery_id: string | null; name: string | null } | undefined> {
  const { rows } = await harness.install.owner.query("SELECT client_discovery_id, name FROM oauth_clients WHERE client_id = $1", [clientId]);
  return rows[0];
}

describe("a client identified by a Client ID Metadata Document", () => {
  it("is advertised in the authorization server metadata", async () => {
    const metadata = (await (await harness.handle(new Request(`${URL_OF_INSTALL}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(metadata["client_id_metadata_document_supported"]).toBe(true);
  });

  it("is identified by a document whose client_id equals its URL: the request goes on to the consent screen", async () => {
    const clientId = "https://vendor.example/oauth/client.json";
    const answer = await authorizeAs(clientId);
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.pathname).toBe("/consent");
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(fetched).toEqual([clientId]);
    expect(connections.map(({ address, hostname }) => `${hostname} ${address}`)).toEqual(["vendor.example 93.184.215.14"]);
    expect(await clientRow(clientId)).toEqual({ client_discovery_id: "cimd", name: "Vendor agent" });
  });

  it("is refused when the document carries another client_id, with no consent screen and no client", async () => {
    const clientId = "https://vendor.example/oauth/mismatched.json";
    const answer = await authorizeAs(clientId);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error?: string }).error).toBe("invalid_client");
    expect(answer.headers.get("location")).toBeNull();
    expect(await clientRow(clientId)).toBeUndefined();
  });

  it("is refused without a connection when its host resolves to an internal address", async () => {
    const clientId = "https://internal.vendor.example/oauth/client.json";
    const answer = await authorizeAs(clientId);
    expect(answer.status).toBe(400);
    expect(answer.headers.get("location")).toBeNull();
    expect(connections).toEqual([]);
    expect(fetched).toEqual([]);
    expect(await clientRow(clientId)).toBeUndefined();
  });

  it("is refused with 400 invalid_client when its document holds a NUL character, which no text Tiehall stores may hold", async () => {
    const clientId = "https://vendor.example/oauth/nul.json";
    const answer = await authorizeAs(clientId);
    expect(answer.status).toBe(400);
    const body = (await answer.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toMatch(/NUL/);
    expect(answer.headers.get("location")).toBeNull();
    expect(await clientRow(clientId)).toBeUndefined();
  });

  it("is refused when its document redirects, and the redirect is not followed", async () => {
    const answer = await authorizeAs("https://vendor.example/oauth/moved.json");
    expect(answer.status).toBe(400);
    expect(fetched).toEqual(["https://vendor.example/oauth/moved.json"]);
  });
});

// agent-access: Clients identified by a Client ID Metadata Document are preferred (decisions-from-groups-15-28:
// design.md, Decisions this change rests on: D55 (25); Technical decisions: T4). A client_id URL has at most 1,024
// characters, and a document gives a name of 1 to 100 characters and at most 10 redirect URIs of at most 2,048
// characters each: an authorization request outside these bounds is refused with invalid_client, a URL too long without
// fetching anything, and never with a 500. A client at the URL's bound works throughout, as the database's own bounds
// on what a client's id is written into allow.
describe("the bounds of a client identified by its metadata document", () => {
  /** A client id URL on vendor.example of exactly this many characters. */
  function clientIdOf(length: number): string {
    const start = "https://vendor.example/oauth/";
    return `${start}${"p".repeat(length - start.length - ".json".length)}.json`;
  }

  it("refuses a client_id URL of 1,025 characters with invalid_client, fetching nothing", async () => {
    const clientId = clientIdOf(1025);
    expect(clientId).toHaveLength(1025);
    const answer = await authorizeAs(clientId);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error?: string }).error).toBe("invalid_client");
    expect(fetched).toEqual([]);
    expect(connections).toEqual([]);
    expect(await clientRow(clientId)).toBeUndefined();
  });

  it("refuses a document whose name has 101 characters, or that lists 11 redirect URIs, with invalid_client and no consent screen", async () => {
    for (const clientId of ["https://vendor.example/oauth/long-name.json", "https://vendor.example/oauth/many-redirects.json"]) {
      const answer = await authorizeAs(clientId);
      expect(answer.status, clientId).toBe(400);
      expect(((await answer.json()) as { error?: string }).error, clientId).toBe("invalid_client");
      expect(answer.headers.get("location"), clientId).toBeNull();
      expect(await clientRow(clientId), clientId).toBeUndefined();
    }
  });

  it("lets a client whose client_id URL has 1,024 characters sign in, write, read its updates and repeat a write, with no 500", async () => {
    const clientId = clientIdOf(1024);
    expect(clientId).toHaveLength(1024);
    await addTeam(harness.install.owner, "FE");
    const be = await addTeam(harness.install.owner, "BE");
    await joinTeams(harness.install.owner, ana.userId, be);

    // The authorization request goes on to the consent screen, where Ana approves the client.
    const pkce = pkcePair();
    const started = await harness.authorize(ana.cookie, { clientId, redirectUri: CLIENT_REDIRECT_URI }, pkce, { scope: "requests:read requests:write" }, { "x-forwarded-for": "198.51.100.200" });
    const consent = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(consent.pathname).toBe("/consent");
    const html = await (await harness.handle(new Request(consent, { headers: { cookie: ana.cookie, accept: "text/html" } }))).text();
    const confirmed = await harness.handle(
      new Request(`${URL_OF_INSTALL}/confirm/agent_clients.approve`, {
        method: "POST",
        headers: { cookie: ana.cookie, "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin", accept: "text/html" },
        body: new URLSearchParams({ input: hiddenField(html, "input"), nonce: hiddenField(html, "nonce"), csrf: hiddenField(html, "csrf") }).toString(),
      }),
    );
    expect(confirmed.status).toBe(303);
    const back = await harness.handle(new Request(new URL(confirmed.headers.get("location") ?? "", URL_OF_INSTALL), { headers: { cookie: ana.cookie, accept: "text/html" } }));
    const code = new URL(back.headers.get("location") ?? "", URL_OF_INSTALL).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const exchanged = await harness.exchange({ clientId, redirectUri: CLIENT_REDIRECT_URI }, code, pkce);
    expect(exchanged.status).toBe(200);
    const authorization = `Bearer ${String(exchanged.body["access_token"])}`;

    // A write with an Idempotency-Key, and its repeat, which gets the first answer.
    const open = () =>
      harness.api("POST", "/api/v1/requests", { authorization, "idempotency-key": "open-dark-mode" }, { targetTeam: "FE", requestingTeam: "BE", title: "Add a dark mode", packet: packetOf() });
    const first = await open();
    expect(first.status).toBe(200);
    const repeated = await open();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await first.json());
    // The client's own updates, read and acknowledged, which move its cursor.
    const read = await harness.api("POST", "/api/v1/updates", { authorization }, {});
    expect(read.status).toBe(200);
    const { cursor } = (await read.json()) as { cursor: number };
    const acknowledged = await harness.api("POST", "/api/v1/updates", { authorization }, { acknowledge: cursor + 1 });
    expect(acknowledged.status).toBeLessThan(500);
    // Its refresh token works too.
    const refreshed = await harness.refresh({ clientId, redirectUri: CLIENT_REDIRECT_URI }, String(exchanged.body["refresh_token"]));
    expect(refreshed.status).toBe(200);
  });
});

describe("the fetches from one host", () => {
  it("are at most 60 a minute: the next authorization request from that host's clients gets 429 with Retry-After, and nothing is fetched", async () => {
    for (let index = 1; index <= 60; index += 1) {
      const answer = await authorizeAs(`https://busy.example/clients/${index}.json`, `198.51.100.${index}`);
      expect(answer.status, `client ${index}`).toBe(302);
    }
    expect(fetched).toHaveLength(60);
    const refused = await authorizeAs("https://busy.example/clients/61.json", "198.51.100.61");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { type?: string }).type).toBe("https://tiehall.com/problems/rate-limited");
    expect(fetched).toHaveLength(60);
    // Another host has its own 60.
    expect((await authorizeAs("https://quiet.example/clients/1.json", "198.51.100.62")).status).toBe(302);
  });

  it("count together whatever port each client id names: a host is one host on any port", async () => {
    for (let index = 1; index <= 60; index += 1) {
      const answer = await authorizeAs(`https://ports.example:${8000 + index}/clients/${index}.json`, `203.0.113.${index}`);
      expect(answer.status, `client ${index}`).toBe(302);
    }
    expect(fetched).toHaveLength(60);
    const refused = await authorizeAs("https://ports.example:8061/clients/61.json", "203.0.113.61");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await authorizeAs("https://ports.example/clients/62.json", "203.0.113.62")).status).toBe(429);
    expect(fetched).toHaveLength(60);
  });
});
