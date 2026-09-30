import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { Role } from "@tiehall/core";
import type { WebSessionCaller } from "../../src/index.ts";
import type { AgentAccessHarness } from "./agent-access.ts";
import { URL_OF_INSTALL } from "./install.ts";
import { addTeam, joinTeams, sessionOf } from "./requests.ts";

// MCP clients for the tool contract tests (agent-surfaces: One MCP endpoint
// for both protocol versions; agent-surfaces: The MCP tools; design.md,
// Technical decisions: T9 and T17). Each client is the official MCP SDK
// client, speaking one of the two protocol versions the install serves, and
// reaches the install's /mcp through the agent-access harness, which answers
// as the web role routes a call, without the network: its access token rides
// in the Authorization header of every request. A client can keep a log of
// its HTTP exchanges with /mcp, so a test can check what went over the wire,
// such as a status or a session header.

/** The protocol version of the per-request envelope, which a client pins. */
export const MODERN = "2026-07-28";
/** The 2025 protocol version, whose clients start with initialize. */
export const LEGACY = "2025-11-25";
export const PROTOCOL_VERSIONS = [MODERN, LEGACY] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** Where the install's MCP endpoint is. */
export const MCP_URL = `${URL_OF_INSTALL}/mcp`;

/** One HTTP exchange of a client with /mcp. */
export interface McpExchange {
  method: string;
  /** The JSON-RPC method the body carries, such as tools/call; undefined for a body that names none. */
  rpcMethod: string | undefined;
  status: number;
  sessionIdSent: string | null;
  sessionIdReceived: string | null;
  wwwAuthenticate: string | null;
  contentType: string | null;
  /** The answer's body, for an answer that is no event stream. */
  body: string | undefined;
}

export interface McpClientOptions {
  /** The access token or personal access token the client sends; none sends no Authorization header. */
  token?: string;
  version: ProtocolVersion;
  /** The name the client gives itself, such as a real client's; a contract test's own unless given. */
  name?: string;
  /** The client capabilities it declares, such as elicitation. */
  capabilities?: Record<string, unknown>;
  /** Where its HTTP exchanges with /mcp are logged, in order. */
  log?: McpExchange[];
}

/** An SDK client of this protocol version, not connected yet. */
export function mcpClient(options: Pick<McpClientOptions, "version" | "capabilities" | "name">): Client {
  return new Client(
    { name: options.name ?? `tiehall-contract-test-${options.version}`, version: "0.0.0" },
    {
      capabilities: options.capabilities ?? {},
      ...(options.version === MODERN ? { versionNegotiation: { mode: { pin: MODERN } } } : {}),
    },
  );
}

/** The client's transport to the install's /mcp, through the harness, with the token and the log. */
export function mcpTransport(harness: AgentAccessHarness, options: Pick<McpClientOptions, "token" | "log">): StreamableHTTPClientTransport {
  const fetchThroughHarness = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (options.token !== undefined) request.headers.set("authorization", `Bearer ${options.token}`);
    const sent = init?.body;
    const text = typeof sent === "string" ? sent : undefined;
    const response = await harness.handle(request);
    if (options.log !== undefined) {
      const streamed = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
      const body = streamed ? undefined : await response.clone().text();
      options.log.push({
        method: request.method,
        rpcMethod: rpcMethodOf(text),
        status: response.status,
        sessionIdSent: request.headers.get("mcp-session-id"),
        sessionIdReceived: response.headers.get("mcp-session-id"),
        wwwAuthenticate: response.headers.get("www-authenticate"),
        contentType: response.headers.get("content-type"),
        body,
      });
    }
    return response;
  };
  return new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetchThroughHarness });
}

/** A client connected to the install's /mcp; the connection fails the test when /mcp refuses it. */
export async function connectMcp(harness: AgentAccessHarness, options: McpClientOptions): Promise<Client> {
  const client = mcpClient(options);
  await client.connect(mcpTransport(harness, options));
  return client;
}

/** The JSON-RPC method a request body names. */
function rpcMethodOf(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof first === "object" && first !== null && typeof (first as { method?: unknown }).method === "string"
      ? (first as { method: string }).method
      : undefined;
  } catch {
    return undefined;
  }
}

/** The markdown a tool result carries: its text contents, joined. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The problem a refused tool call carries, as the error model gives it. */
export function problemOf(result: CallToolResult): { type?: string; status?: number; detail?: string; errors?: unknown } {
  if (result.isError !== true) throw new Error(`The tool call was not refused: ${textOf(result).slice(0, 500)}`);
  return JSON.parse(textOf(result)) as { type?: string; status?: number; detail?: string; errors?: unknown };
}

/** Where a problem type's URI starts. */
export const PROBLEM = "https://tiehall.com/problems/";

/** A member of the install whose agent holds an OAuth access token from the real flow, and who has a web session. */
export interface McpPerson {
  userId: string;
  login: string;
  /** Their browser's Cookie header, signed in to the web UI. */
  cookie: string;
  /** The access token their agent client holds, for the install's MCP resource. */
  token: string;
  /** A web session of theirs, for the web UI's operations. */
  session: WebSessionCaller;
}

/**
 * Adds the teams with these keys and returns their ids by key; a key the
 * install has already is taken as it is.
 */
export async function addTeams(harness: AgentAccessHarness, ...keys: string[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const key of keys) {
    const { rows } = await harness.install.owner.query<{ id: string }>("SELECT id FROM teams WHERE key = $1", [key]);
    ids[key] = rows[0]?.id ?? (await addTeam(harness.install.owner, key));
  }
  return ids;
}

/**
 * A member of the install who signed in with GitHub, with this role, in these
 * teams, whose agent client went through the authorization code flow and
 * holds an access token with these scopes, requests:read and requests:write
 * unless others are given.
 */
export async function mcpPerson(
  harness: AgentAccessHarness,
  login: string,
  options: { teams?: readonly string[]; role?: Role; scopes?: readonly string[] } = {},
): Promise<McpPerson> {
  const signedIn = await harness.member(login);
  if (options.role === "admin") await harness.install.owner.query("UPDATE members SET role = 'admin' WHERE user_id = $1", [signedIn.userId]);
  const teams = await addTeams(harness, ...(options.teams ?? []));
  await joinTeams(harness.install.owner, signedIn.userId, ...Object.values(teams));
  const { accessToken } = await harness.tokens(signedIn, options.scopes);
  return { ...signedIn, login, token: accessToken, session: sessionOf(signedIn.userId) };
}

/**
 * The size of a tool result as an agent reads it: the characters of its text
 * contents and of its structured content as compact JSON.
 */
export function resultSize(result: CallToolResult): number {
  const structured = result.structuredContent === undefined ? 0 : JSON.stringify(result.structuredContent).length;
  return textOf(result).length + structured;
}
