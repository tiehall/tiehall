import { createMcpHandler, Server, type AuthInfo, type CallToolResult, type McpHttpHandler, type Tool } from "@modelcontextprotocol/server";
import { toolListing, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, toolError } from "@tiehall/core";
import type { Database } from "@tiehall/db";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { DEFAULT_SCOPES } from "./authorization-server.ts";
import { bodyLimitFor, readBoundedBody } from "./body-limit.ts";
import type { Caller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";
import { TOOL_TEXTS, toolTexts, type ToolText } from "./mcp-texts.ts";
import { teamsOfMember } from "./members.ts";
import type { Origin } from "./write.ts";
import { withOrg } from "./with-org.ts";

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
// Admin actions and trust changes are on no agent surface).
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
//   valid gets 401 invalid_token, pointing there too;
// - re-checks, for an access token, that no removal revoked it, as execute()
//   does: a token issued before its user's current membership began gets 401
//   invalid_token (teams-and-roles: Removing a member);
// - refuses a tool call whose token lacks a scope the tool's operation needs
//   with HTTP 403 insufficient_scope, naming the scope, before anything runs.
// These are the OAuth refusals, which on /mcp are HTTP statuses and never tool
// results, as the error model defines; they are RFC 9457 problems, whatever
// the call accepts. A personal access token the token check refuses because
// its person is not a member of the install is the one refusal of the check
// that is no OAuth refusal: every tool call such a caller makes is answered
// with that refusal as a tool error, and so returns no data of the install
// (teams-and-roles: Membership is re-checked on every call).
//
// A call the checks admit acts for the token's user, on the surface mcp, and
// every tool it calls runs its operation through execute() as that caller, so
// MCP applies the same authorization as every other surface
// (agent-surfaces: Tool results carry structured content and fenced
// markdown; public-api: One error model for Tiehall's own refusals). A tool's
// result carries the operation's output, which execute() validated against
// the output schema the tool list shows lowered, as its structured content,
// as agents read JSON, and the markdown its renderer writes from it, with
// every text Tiehall did not write fenced with its origin as the caller sees
// it: the caller's teams are read in the call's own transaction. A proposal a
// commitment created is Tiehall's own text. Every refusal of the operation is
// a tool result with isError whose content is the error model's problem, which
// names its type: input that fails the schema, one whose variants are mixed
// included, since execute() validates with the operation's own schema. A
// failure that is not one of Tiehall's refusals is such a result too, a 500
// that says nothing about itself.

/** How the MCP server names itself to clients. */
export const MCP_SERVER_NAME = "tiehall";

export interface McpRouteOptions {
  catalog: Catalog;
  execute: Execute;
  /** Who is calling, from the call's credentials; undefined when it carries none; a refusal for a token that is not valid. */
  authenticate(request: Request): Promise<Caller | undefined>;
  /** The URL of the protected resource metadata, which the challenge of a refused call points to. */
  resourceMetadata?: string;
  /** The renderer of each tool's markdown, by its operation's id; the real ones unless given. */
  texts?: Readonly<Record<string, ToolText>>;
  /** The app's database, where the route re-checks that a call's access token was not revoked by a removal; no re-check without it. */
  database?: Database;
  /** The release the install runs, which the server names itself with; 0.0.0-dev unless given. */
  version?: string;
  logger?: Logger;
}

export type McpRoute = (request: Request) => Promise<Response>;

/** The refusals of a call's token, whose challenge points to the protected resource metadata. */
const CHALLENGED: ReadonlySet<string> = new Set(["unauthenticated", "invalid-token", "insufficient-scope"]);

/** Who a call acts for, or the refusal every tool call it makes gets. */
type Calling = { caller: Caller; origin: Origin } | { refusal: Refusal };

/** What the SDK hands the server factory for the call. */
interface CallingInfo extends AuthInfo {
  extra: { calling: Calling };
}

export function createMcpRoute(options: McpRouteOptions): McpRoute {
  const logger = options.logger ?? createLogger();
  const { catalog } = options;
  const version = options.version ?? "0.0.0-dev";
  const texts = options.texts ?? TOOL_TEXTS;
  // The operation behind each tool, and the renderer of its markdown, which every tool has.
  const operations = new Map<string, CommandDefinition>();
  for (const definition of catalog.commands) {
    if (definition.surfaces.includes("mcp") && definition.tool !== undefined) operations.set(definition.tool, definition);
  }
  const unrendered = [...operations.values()].filter(({ id }) => !Object.hasOwn(texts, id)).map(({ id }) => id);
  if (unrendered.length > 0) throw new Error(`These tools have no renderer of their markdown: ${unrendered.join(", ")}.`);
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

  /** Runs the tool's operation through execute() for the call; a refusal is a tool result with isError. */
  async function callTool(calling: Calling, name: string, args: unknown): Promise<CallToolResult> {
    const definition = operations.get(name);
    if (definition === undefined) return refused(new Refusal("route-not-found", "There is no such tool here."));
    if ("refusal" in calling) return refused(calling.refusal);
    const { caller, origin } = calling;
    const render = texts[definition.id];
    if (render === undefined) throw new Error(`${definition.id} has no renderer of its markdown.`);
    // The keys of the caller's teams, read in the call's own transaction, decide each text's origin.
    let teams: string[] = [];
    const executeOptions: ExecuteOptions = {
      origin,
      around: async (context, run) => {
        const output = await run();
        if ("userId" in caller && caller.userId !== undefined) teams = (await teamsOfMember(context, caller.userId)).map(({ key }) => key);
        return output;
      },
    };
    try {
      const output = agentJson(await options.execute(definition.id, caller, args ?? {}, executeOptions));
      const markdown = createAgentView().markdown(toolTexts(render, output, { teams }));
      return { content: [{ type: "text", text: markdown }], structuredContent: output as Record<string, unknown> };
    } catch (error) {
      if (error instanceof Refusal) return refused(error);
      logger.error("mcp: the tool failed", { operationId: definition.id, error });
      // A failure that is not one of Tiehall's own refusals says nothing about itself, as REST's 500 does.
      return { isError: true, content: [{ type: "text", text: JSON.stringify(internalErrorProblem().body) }] };
    }
  }

  // One fresh server per call, for whoever the route found the call acts for, on either protocol version.
  const handler: McpHttpHandler = createMcpHandler(
    ({ authInfo }) => {
      const calling = (authInfo as CallingInfo | undefined)?.extra.calling;
      if (calling === undefined) throw new Error("The MCP route hands every call to the SDK with whoever it acts for.");
      const server = new Server({ name: MCP_SERVER_NAME, version }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({ tools: listed }));
      server.setRequestHandler("tools/call", async (request) => callTool(calling, request.params.name, request.params.arguments));
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
    let calling: Calling;
    let authInfo: CallingInfo;
    try {
      const found = await options.authenticate(request);
      if (found === undefined) {
        return problem(
          challenged(new Refusal("unauthenticated", "The MCP server needs a token in the Authorization header.", { challenge: { scope: DEFAULT_SCOPES } })),
        );
      }
      const caller = onTheMcpSurface(found);
      const refusedToken = (await revokedByRemoval(caller)) ?? scopeRefusal(caller, body);
      if (refusedToken !== undefined) return problem(challenged(refusedToken));
      const ipAddress = request.headers.get("x-forwarded-for") ?? undefined;
      const userAgent = request.headers.get("user-agent") ?? undefined;
      calling = { caller, origin: { ...(ipAddress === undefined ? {} : { ipAddress }), ...(userAgent === undefined ? {} : { userAgent }) } };
      authInfo = {
        // The token itself is not handed on: nothing past the check needs it.
        token: "",
        clientId: caller.kind === "oauth_token" ? caller.clientId : caller.kind,
        scopes: caller.kind === "oauth_token" || caller.kind === "personal_access_token" ? [...caller.scopes] : [],
        extra: { calling },
      };
    } catch (error) {
      // A person the token check found not to be a member gets a tool error for every tool call, and no data.
      if (error instanceof Refusal && error.reason === "removed-member") {
        calling = { refusal: error };
        authInfo = { token: "", clientId: "removed-member", scopes: [], extra: { calling } };
      } else if (error instanceof Refusal) {
        return problem(challenged(error));
      } else {
        logger.error("mcp: the token check failed", { error });
        return internalError();
      }
    }
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

  /**
   * The refusal of an access token that a removal revoked, as execute()'s
   * membership re-check gives it, or of setup that is not complete; none for a
   * caller the re-check lets through, or refuses otherwise, such as a removed
   * member, whose tool calls get that refusal as a tool error.
   */
  async function revokedByRemoval(caller: Caller): Promise<Refusal | undefined> {
    if (options.database === undefined || (caller.kind !== "oauth_token" && caller.kind !== "personal_access_token")) return undefined;
    try {
      await withOrg(options.database, async () => {}, {
        readOnly: true,
        forUser: caller.userId,
        personalAccessToken: caller.kind === "personal_access_token",
        issuedAt: caller.kind === "oauth_token" ? caller.issuedAt : undefined,
      });
      return undefined;
    } catch (error) {
      if (error instanceof Refusal && (error.reason === "invalid-token" || error.reason === "setup-required")) return error;
      if (error instanceof Refusal) return undefined;
      throw error;
    }
  }

  /** The refusal of a tool call the body makes whose token lacks a scope its operation needs; none when every scope is there. */
  function scopeRefusal(caller: Caller, body: Uint8Array): Refusal | undefined {
    if (caller.kind !== "oauth_token" && caller.kind !== "personal_access_token") return undefined;
    for (const name of calledTools(body)) {
      const definition = operations.get(name);
      const missing = definition === undefined ? [] : definition.scopes.filter((scope) => !caller.scopes.includes(scope));
      if (missing.length > 0) {
        return new Refusal("insufficient-scope", `This tool needs the scope ${missing.join(" and ")}, which this token does not carry.`, {
          challenge: { scope: missing },
        });
      }
    }
    return undefined;
  }

  /** A refusal of the call's token, whose challenge points to the protected resource metadata; any other refusal as it is. */
  function challenged(refusal: Refusal): Refusal {
    const { resourceMetadata } = options;
    if (resourceMetadata === undefined || !CHALLENGED.has(refusal.reason)) return refusal;
    return refusal.withChallenge({ resourceMetadata });
  }
}

/** Reads a body's bytes as UTF-8 text. */
const decoder = new TextDecoder();

/** The names of the tools the JSON-RPC messages of a body call; none for a body that is not JSON. */
function calledTools(body: Uint8Array): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return [];
  }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    const name = typeof params === "object" && params !== null ? (params as { name?: unknown }).name : undefined;
    if (method === "tools/call" && typeof name === "string") names.push(name);
  }
  return names;
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
