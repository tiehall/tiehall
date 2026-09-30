import { createMcpHandler, Server, type AuthInfo, type CallToolResult, type McpHttpHandler, type Tool } from "@modelcontextprotocol/server";
import { toolListing, type Catalog } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, toolError } from "@tiehall/core";
import { agentJson } from "@tiehall/packet/render";
import { DEFAULT_SCOPES } from "./authorization-server.ts";
import { bodyLimitFor, readBoundedBody } from "./body-limit.ts";
import type { Caller } from "./caller.ts";
import type { Execute } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";

// The install's MCP endpoint, /mcp (agent-surfaces: Four agent surfaces;
// agent-surfaces: One MCP endpoint for both protocol versions; agent-access:
// Tiehall is the authorization server for agent clients; agent-access:
// Missing and insufficient tokens get standard challenges; agent-access:
// Credentials are accepted only in the Authorization header; design.md,
// Design rules: Agent surfaces; design.md, Technical decisions: T9). It is
// served with the official MCP SDK's createMcpHandler, statelessly: one
// endpoint answers clients on protocol version 2026-07-28, whose requests each
// carry their own envelope, and clients on 2025-11-25, each of whose requests
// the SDK answers with a fresh server, so no protocol session is kept between
// calls and none is ever handed out. The server offers tools only, with no
// resources and no prompts; its tools come from the catalog's operations
// offered on MCP. The tool list is the same for every caller, whatever their
// role, since no operation an agent surface offers is an admin action: each
// tool carries its lowered schemas, MCP annotations, whose read-only hint only
// a tool that only reads carries, and its operation's stability level in
// _meta (agent-surfaces: Tool annotations and stability levels; agent-surfaces:
// Admin actions and trust changes are on no agent surface). A tool call runs
// its operation through execute() as the caller.
//
// Before the SDK sees a call, the route:
// - reads its body, up to the size limit every path but contract.report and
//   the webhooks has, 2 MiB, and refuses a larger one with HTTP 413 before
//   anything else about the call is judged, as REST does (public-api: Request
//   bodies have a size limit);
// - asks who is calling, from the token in the Authorization header alone,
//   with the same check as /api/v1: an OAuth access token the install issued
//   for its MCP resource, or a personal access token. A call without one gets
//   HTTP 401 with a challenge that points to the protected resource metadata
//   and carries the scopes the tools need as its hint, and a token that is not
//   valid gets 401 invalid_token, pointing there too. These are HTTP
//   statuses, never tool results, as the error model defines for the OAuth
//   refusals on /mcp; they are RFC 9457 problems, whatever the call accepts.
// A call the token check admits acts for the token's user, on the surface
// mcp, and every tool it calls runs through execute() as that caller, so MCP
// applies the same authorization as every other surface.

/** How the MCP server names itself to clients. */
export const MCP_SERVER_NAME = "tiehall";

export interface McpRouteOptions {
  catalog: Catalog;
  execute: Execute;
  /** Who is calling, from the call's credentials; undefined when it carries none; a refusal for a token that is not valid. */
  authenticate(request: Request): Promise<Caller | undefined>;
  /** The URL of the protected resource metadata, which the challenge of a refused call points to. */
  resourceMetadata?: string;
  /** The release the install runs, which the server names itself with; 0.0.0-dev unless given. */
  version?: string;
  logger?: Logger;
}

export type McpRoute = (request: Request) => Promise<Response>;

/** The refusals of a call's token, whose challenge points to the protected resource metadata. */
const CHALLENGED: ReadonlySet<string> = new Set(["unauthenticated", "invalid-token", "insufficient-scope"]);

/** What the SDK hands the server factory for the call: its caller. */
interface CallerInfo extends AuthInfo {
  extra: { caller: Caller };
}

export function createMcpRoute(options: McpRouteOptions): McpRoute {
  const logger = options.logger ?? createLogger();
  const { catalog } = options;
  const version = options.version ?? "0.0.0-dev";
  // The tools as the tool list shows them, computed once: each operation offered on MCP, with its lowered
  // schemas, its annotations and its stability level in _meta; the same for every caller, whatever their role.
  const listed: Tool[] = toolListing(catalog).map(({ name, description, inputSchema, outputSchema, annotations, _meta }) => ({
    name,
    description,
    inputSchema: inputSchema as Tool["inputSchema"],
    outputSchema: outputSchema as Tool["outputSchema"],
    annotations: { ...annotations },
    _meta: { ..._meta },
  }));
  // The operation behind each tool.
  const operations = new Map(catalog.commands.filter(({ surfaces }) => surfaces.includes("mcp")).map((definition) => [definition.tool, definition]));

  /** Runs the tool's operation through execute() as the caller; a refusal is a tool result with isError. */
  async function callTool(caller: Caller, name: string, args: unknown): Promise<CallToolResult> {
    const definition = operations.get(name);
    if (definition === undefined) return refused(new Refusal("route-not-found", "There is no such tool here."));
    try {
      const output = agentJson(await options.execute(definition.id, caller, args ?? {}));
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output as Record<string, unknown> };
    } catch (error) {
      if (error instanceof Refusal) return refused(error);
      logger.error("mcp: the tool failed", { operationId: definition.id, error });
      // A failure that is not one of Tiehall's own refusals says nothing about itself, as REST's 500 does.
      return { isError: true, content: [{ type: "text", text: JSON.stringify(internalErrorProblem().body) }] };
    }
  }

  // One fresh server per call, for the caller the route authenticated, on either protocol version.
  const handler: McpHttpHandler = createMcpHandler(
    ({ authInfo }) => {
      const caller = (authInfo as CallerInfo | undefined)?.extra.caller;
      if (caller === undefined) throw new Error("The MCP route hands every call to the SDK with its caller.");
      const server = new Server({ name: MCP_SERVER_NAME, version }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({ tools: listed }));
      server.setRequestHandler("tools/call", async (request) => callTool(caller, request.params.name, request.params.arguments));
      return server;
    },
    { onerror: (error) => logger.warn("mcp: the SDK refused a call", { error }) },
  );

  return async function handle(request) {
    const url = new URL(request.url);
    let body: Uint8Array;
    try {
      body = await readBoundedBody(request, bodyLimitFor(request.method, url.pathname, catalog));
    } catch (error) {
      if (error instanceof Refusal) return problem(error);
      logger.error("mcp: the body could not be read", { error });
      return internalError();
    }
    let caller: Caller | undefined;
    try {
      caller = await options.authenticate(request);
    } catch (error) {
      if (error instanceof Refusal) return problem(challenged(error));
      logger.error("mcp: the token check failed", { error });
      return internalError();
    }
    if (caller === undefined) {
      return problem(
        challenged(new Refusal("unauthenticated", "The MCP server needs a token in the Authorization header.", { challenge: { scope: DEFAULT_SCOPES } })),
      );
    }
    const onMcp = onTheMcpSurface(caller);
    const authInfo: CallerInfo = {
      // The token itself is not handed on: nothing past the check needs it.
      token: "",
      clientId: onMcp.kind === "oauth_token" ? onMcp.clientId : onMcp.kind,
      scopes: onMcp.kind === "oauth_token" || onMcp.kind === "personal_access_token" ? [...onMcp.scopes] : [],
      extra: { caller: onMcp },
    };
    try {
      // The SDK reads the body again, from a request that carries the bytes the route read.
      const forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        ...(body.byteLength > 0 ? { body: new Uint8Array(body) } : {}),
      });
      return await handler.fetch(forwarded, { authInfo });
    } catch (error) {
      logger.error("mcp: the call failed", { error });
      return internalError();
    }
  };

  /** A refusal of the call's token, whose challenge points to the protected resource metadata; any other refusal as it is. */
  function challenged(refusal: Refusal): Refusal {
    const { resourceMetadata } = options;
    if (resourceMetadata === undefined || !CHALLENGED.has(refusal.reason)) return refusal;
    return refusal.withChallenge({ resourceMetadata });
  }
}

/** The caller as one that came through MCP: an agent's token call is recorded with the surface mcp. */
function onTheMcpSurface(caller: Caller): Caller {
  return caller.kind === "oauth_token" || caller.kind === "personal_access_token" ? { ...caller, surface: "mcp" } : caller;
}

/** A refusal as a tool result: isError, with the error model's problem, which names its type, as its content. */
function refused(refusal: Refusal): CallToolResult {
  const { isError, content } = toolError(refusal);
  return { isError, content: [...content] };
}

/** A refusal as an RFC 9457 problem details response. */
function problem(refusal: Refusal): Response {
  const { status, headers, body } = httpProblem(refusal);
  return new Response(JSON.stringify(body), { status, headers });
}

function internalError(): Response {
  const { status, headers, body } = internalErrorProblem();
  return new Response(JSON.stringify(body), { status, headers });
}
