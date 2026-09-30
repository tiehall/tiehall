import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboundFetcher } from "../src/index.ts";
import { agentClientsOf } from "../src/web.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { CLIENT_REDIRECT_URI, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// The operator can switch metadata-document fetching off (agent-access: The
// operator can switch metadata-document fetching off; self-host-install: The
// setting that switches metadata-document fetching off; design.md, Decisions
// this change rests on: D28 #43; design.md, Self-hosting decisions: S2 and
// S13). With TIEHALL_CLIENT_METADATA_FETCH=off, Tiehall fetches no Client ID
// Metadata Document: its authorization server metadata stops advertising
// them, and an authorization request whose client_id is a URL is refused
// without that URL being fetched, while a client that registers through
// Dynamic Client Registration still reaches the consent screen. Unset, the
// setting is on, and the web role's sign-in service fetches them.

let harness: AgentAccessHarness;
let ana: SignedIn;
const fetched: string[] = [];

beforeAll(async () => {
  const fetchDocument: OutboundFetcher = async (url) => {
    fetched.push(url);
    throw new Error("No metadata document is fetched while fetching is off.");
  };
  harness = await startAgentAccess({ clientMetadata: { metadataDocuments: false, fetchDocument } });
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe("with metadata-document fetching switched off", () => {
  it("the authorization server metadata does not advertise client_id_metadata_document_supported", async () => {
    const metadata = (await (await harness.handle(new Request(`${URL_OF_INSTALL}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(metadata["issuer"]).toBe(URL_OF_INSTALL);
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
  });

  it("refuses an authorization request whose client_id is a URL, and fetches nothing", async () => {
    const clientId = "https://vendor.example/oauth/client.json";
    const answer = await harness.authorize(ana.cookie, { clientId, redirectUri: CLIENT_REDIRECT_URI }, pkcePair(), { scope: "requests:read" });
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.pathname).not.toBe("/consent");
    expect(location.origin).toBe(URL_OF_INSTALL);
    expect(location.searchParams.get("error")).toBe("invalid_client");
    expect(location.searchParams.get("code")).toBeNull();
    expect(fetched).toEqual([]);
    const { rows } = await harness.install.owner.query("SELECT count(*) FROM oauth_clients WHERE client_id = $1", [clientId]);
    expect(Number(rows[0].count)).toBe(0);
  });

  it("still lets a client register through Dynamic Client Registration and reach the consent screen", async () => {
    const client = await harness.registerClient();
    const answer = await harness.authorize(ana.cookie, client, pkcePair(), { scope: "requests:read" });
    expect(answer.status).toBe(302);
    expect(new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL).pathname).toBe("/consent");
    expect(fetched).toEqual([]);
  });
});

describe("the web role's sign-in service", () => {
  it("fetches metadata documents when TIEHALL_CLIENT_METADATA_FETCH is unset or on, and not when it is off", () => {
    expect(agentClientsOf({})).toEqual({ metadataDocuments: true });
    expect(agentClientsOf({ TIEHALL_CLIENT_METADATA_FETCH: "on" })).toEqual({ metadataDocuments: true });
    expect(agentClientsOf({ TIEHALL_CLIENT_METADATA_FETCH: "off" })).toEqual({ metadataDocuments: false });
  });
});
