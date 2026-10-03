import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { Page } from "playwright-core";
import { freePort } from "./install.ts";

// An agent's MCP client for the end-to-end test of an install
// (agent-surfaces: Four agent surfaces; agent-surfaces: One MCP endpoint for
// both protocol versions; agent-access: The consent screen shows who is
// asking): the official MCP SDK client, signing in as it does to any MCP
// server that asks for OAuth. /mcp answers its first call with 401 and the
// install's protected resource metadata; the SDK finds the authorization
// server from it, registers itself as a native client with a loopback
// redirect URI, and asks to send the person's browser to the authorization.
// There the person approves it on the consent screen, and the browser brings
// the code back to the client's loopback address, where the client takes it
// and exchanges it for its tokens, as a desktop agent does.

/** The protocol version of the per-request envelope, which the client pins. */
export const MODERN = "2026-07-28";

/** A loopback redirect URI of the client's own, and the answer the browser brings to it. */
interface Loopback {
  url: string;
  received: Promise<URLSearchParams>;
  close(): Promise<void>;
}

async function loopback(): Promise<Loopback> {
  let deliver: (parameters: URLSearchParams) => void = () => {};
  const received = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server: Server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      outgoing.writeHead(404).end();
      return;
    }
    deliver(url.searchParams);
    outgoing.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("The agent is signed in to Tiehall. You can close this window.");
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${port}/callback`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** What the SDK keeps for the client, in memory, as an agent keeps it for the session. */
class AgentAuthorization implements OAuthClientProvider {
  readonly redirect: string;
  readonly name: string;
  /** The URL of the client's Client ID Metadata Document, which the SDK names as its client id where the install fetches such documents. */
  readonly clientMetadataUrl?: string;
  readonly expectedState = randomBytes(16).toString("base64url");
  /** Where the SDK asked to send the person's browser, once it has. */
  authorizationUrl: URL | undefined;
  private information: StoredOAuthClientInformation | undefined;
  private saved: StoredOAuthTokens | undefined;
  private verifier = "";

  constructor(redirect: string, name: string, clientMetadataUrl?: string) {
    this.redirect = redirect;
    this.name = name;
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "requests:read requests:write",
    };
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.information;
  }

  saveClientInformation(information: StoredOAuthClientInformation): void {
    this.information = information;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

function clientNamed(name: string): Client {
  return new Client({ name, version: "0.0.0" }, { capabilities: {}, versionNegotiation: { mode: { pin: MODERN } } });
}

/** How the agent's client identifies itself, besides registering with Dynamic Client Registration. */
export interface AgentIdentity {
  /**
   * The URL of the client's Client ID Metadata Document: the SDK names it as
   * the client id when the install's metadata says it fetches such
   * documents, and registers the client otherwise.
   */
  clientMetadataUrl: string;
  /** Called with the client's loopback redirect URI before the SDK starts, so the document can list it. */
  redirectUri(url: string): void;
}

/**
 * The agent's MCP client for the person whose signed-in browser `page` is,
 * connected to the install's /mcp once the person approved it on the consent
 * screen; fails the test when a step does not go as it should.
 */
export async function connectAgent(installUrl: string, page: Page, name: string, identity?: AgentIdentity): Promise<Client> {
  const endpoint = new URL(`${installUrl}/mcp`);
  const callback = await loopback();
  try {
    identity?.redirectUri(callback.url);
    const authorization = new AgentAuthorization(callback.url, name, identity?.clientMetadataUrl);
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: authorization });
    // The first call gets 401, and the SDK registers the client and asks to send the browser to the authorization.
    const unsigned = clientNamed(name);
    const refused = await unsigned.connect(transport).then(
      () => unsigned.listTools().then(() => undefined),
      (error: unknown) => error,
    );
    await unsigned.close().catch(() => {});
    if (authorization.authorizationUrl === undefined) throw new Error(`the SDK did not ask for an authorization: ${String(refused)}`);
    if (!authorization.authorizationUrl.href.startsWith(`${installUrl}/`)) throw new Error(`the authorization is not the install's: ${authorization.authorizationUrl.href}`);

    // The person approves the client on the install's consent screen, and the browser brings the code back.
    await page.goto(authorization.authorizationUrl.href);
    await page.waitForURL(`${installUrl}/consent?*`);
    await page.getByRole("heading", { name: "Approve an agent client" }).waitFor();
    await Promise.all([page.waitForURL(`${callback.url}?*`), page.getByRole("button", { name: "Confirm" }).click()]);
    const answer = await callback.received;
    if (answer.get("state") !== authorization.expectedState) throw new Error(`the authorization came back with another state: ${answer.toString()}`);
    await transport.finishAuth(answer);

    const client = clientNamed(name);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: authorization }));
    return client;
  } finally {
    await callback.close();
  }
}

/** Calls a tool, and fails the test with the tool's own words when the call is an error; returns its structured content. */
export async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError === true) {
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    throw new Error(`${name} answered with an error: ${text}`);
  }
  return result.structuredContent as T;
}
