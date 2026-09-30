import {
  createMcpHandler,
  Server,
  type AuthInfo,
  type CallToolResult,
  type InputRequiredResult,
  type McpHttpHandler,
  type RequestStateCodec,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server";
import { isProposalAnswer, proposeTool, setRequestStatus, toolListing, type Catalog, type CommandDefinition } from "@tiehall/catalog";
import { httpProblem, internalErrorProblem, Refusal, toolError } from "@tiehall/core";
import type { Database } from "@tiehall/db";
import { agentJson, createAgentView } from "@tiehall/packet/render";
import { DEFAULT_SCOPES } from "./authorization-server.ts";
import { bodyLimitFor, readBoundedBody } from "./body-limit.ts";
import type { Caller } from "./caller.ts";
import type { Execute, ExecuteOptions } from "./execute.ts";
import { createLogger, type Logger } from "./log.ts";
import {
  bindingContext,
  callDigest,
  confirmPageElicitation,
  createRetryStates,
  declaresUrlElicitation,
  retryBinding,
  retryStateOf,
  stateRefused,
  type ElicitedProposal,
  type RetryState,
} from "./mcp-elicitation.ts";
import { retriedTexts, TOOL_TEXTS, toolTexts, type ToolText } from "./mcp-texts.ts";
import { teamsOfMember } from "./members.ts";
import { packetRevisionOf } from "./packet-revisions.ts";
import { proposalView } from "./proposals.ts";
import { requestView } from "./request-views.ts";
import type { Origin } from "./write.ts";
import { withOrg, type OrgContext } from "./with-org.ts";

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
// the call accepts. A token whose person is not a member of the install, a
// personal access token the token check refuses so or an access token the
// re-check finds so, is the one refusal of the checks that is no OAuth
// refusal: every tool call such a caller makes, a retry after an elicitation
// included, is answered with that refusal as a tool error, whatever request
// state it carries, and so returns no data of the install (teams-and-roles:
// Membership is re-checked on every call; public-api: One error model for
// Tiehall's own refusals).
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
//
// A call that creates a proposal, from a client on protocol version
// 2026-07-28 that declares URL-mode elicitation, answers with an
// input-required result instead: the URL-mode elicitation of the proposal's
// confirm page, and a signed request state for the retry
// (mcp-elicitation.ts). Every other client, and every connection on
// 2025-11-25, gets the proposal, which names its web inbox. Only a proposal
// the call created is elicited, as execute() reports it: a call that answers
// with a proposal it ended, such as propose withdrawing one, gets its answer.
//
// The retry that carries the state (agent-surfaces: Retrying after an
// elicitation; agent-surfaces: Accepting an elicitation is not consent) is
// checked by the route before the SDK sees it: a state that was changed, that
// has expired, that is bound to another user or client, or that was issued for
// another call is refused with HTTP 403 and the problem type
// request-state-refused, since the SDK's own refusal would be a JSON-RPC error
// inside an HTTP 200. A state the check admits answers at once, and runs
// nothing again, whatever the client answered to the elicitation, since
// accepting it only means the person agreed to open the page: with the
// applied result, the operation's output as it is now beside the proposal,
// once the commitment took effect; with the proposal and how it ended, once it
// ended without taking effect; and otherwise with the proposal, waiting for
// confirmation, whose outcome reaches the user later. A removed member's retry
// is not checked: it gets the removal as a tool error, as their calls do.

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
  /**
   * The install's URL, TIEHALL_URL, whose confirm pages a URL-mode
   * elicitation opens; with the auth secret and the database, a client that
   * declares URL-mode elicitation gets one for a proposal its call created.
   */
  url?: string;
  /** TIEHALL_AUTH_SECRET, from which the key that signs the request state of an elicitation is derived. */
  secret?: () => string;
  logger?: Logger;
}

export type McpRoute = (request: Request) => Promise<Response>;

/** The refusals of a call's token, whose challenge points to the protected resource metadata. */
const CHALLENGED: ReadonlySet<string> = new Set(["unauthenticated", "invalid-token", "insufficient-scope"]);

/** Who a call acts for, or the refusal every tool call it makes gets. */
type Calling = { caller: Caller; origin: Origin } | { refusal: Refusal };

/** What the SDK hands the server factory for the call, with what a request state is bound to for its caller. */
interface CallingInfo extends AuthInfo {
  extra: { calling: Calling; binding?: string };
}

/** What running a tool gave: its result, and the proposal its call created, if it made a commitment. */
interface ToolAnswer {
  result: CallToolResult;
  proposal?: ElicitedProposal;
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

  // The request states of elicitations, signed with a key derived from the auth secret, made when first needed.
  let states: RequestStateCodec<RetryState> | undefined;
  const statesOf = (): RequestStateCodec<RetryState> | undefined => {
    if (options.secret === undefined) return undefined;
    states ??= createRetryStates(options.secret());
    return states;
  };

  /** Runs the tool's operation through execute() for the call; a refusal is a tool result with isError. */
  async function callTool(calling: Calling, name: string, args: unknown): Promise<ToolAnswer> {
    const definition = operations.get(name);
    if (definition === undefined) return { result: refused(new Refusal("route-not-found", "There is no such tool here.")) };
    if ("refusal" in calling) return { result: refused(calling.refusal) };
    const { caller, origin } = calling;
    const render = texts[definition.id];
    if (render === undefined) throw new Error(`${definition.id} has no renderer of its markdown.`);
    // The keys of the caller's teams, read in the call's own transaction, decide each text's origin.
    let teams: string[] = [];
    // The proposal the call created, if it made a commitment; a call that ended a proposal created none.
    let created: string | undefined;
    const executeOptions: ExecuteOptions = {
      origin,
      around: async (context, run) => {
        const output = await run();
        if ("userId" in caller && caller.userId !== undefined) teams = (await teamsOfMember(context, caller.userId)).map(({ key }) => key);
        return output;
      },
      proposed: (proposalId) => {
        created = proposalId;
      },
    };
    try {
      const output = agentJson(await options.execute(definition.id, caller, args ?? {}, executeOptions));
      const markdown = createAgentView().markdown(toolTexts(render, output, { teams }));
      const result: CallToolResult = { content: [{ type: "text", text: markdown }], structuredContent: output as Record<string, unknown> };
      const proposal = definition.commitment && isProposalAnswer(output) ? (output.proposal as ElicitedProposal) : undefined;
      return proposal !== undefined && created !== undefined && proposal.id === created ? { result, proposal } : { result };
    } catch (error) {
      if (error instanceof Refusal) return { result: refused(error) };
      logger.error("mcp: the tool failed", { operationId: definition.id, error });
      return { result: failed() };
    }
  }

  /**
   * A tool call: its operation's result, or, for a call that created a
   * proposal from a client on 2026-07-28 that declares URL-mode elicitation,
   * the elicitation of the proposal's confirm page with the state of the
   * retry. A retry that carries the state answers with the proposal instead.
   */
  async function answerToolCall(
    calling: Calling,
    era: "legacy" | "modern",
    name: string,
    args: unknown,
    context: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    // A removed member's call, a retry included, gets the removal as a tool error, whatever state it carries.
    if ("refusal" in calling) return (await callTool(calling, name, args)).result;
    const state = context.mcpReq.requestState<unknown>();
    if (state !== undefined) return retried(calling, name, args, state);
    const { result, proposal } = await callTool(calling, name, args);
    const codec = statesOf();
    if (proposal === undefined || codec === undefined || options.url === undefined || options.database === undefined) return result;
    if (!declaresUrlElicitation(era, context)) return result;
    try {
      const minted = await codec.mint({ proposal: proposal.id, call: callDigest(name, args) }, context);
      return confirmPageElicitation(options.url, proposal, minted);
    } catch (error) {
      // The proposal exists either way; a client that cannot be sent to its page is pointed to the web inbox.
      logger.error("mcp: the elicitation could not be made", { error });
      return result;
    }
  }

  /**
   * The retry of a call that created a proposal, with the state its
   * elicitation carried, which the route and the SDK have checked: it answers
   * at once by the proposal as it is now, and runs nothing again. Once the
   * commitment took effect, the result is the operation's output as it is now,
   * the applied result, beside the proposal.
   */
  async function retried(calling: Calling, name: string, args: unknown, payload: unknown): Promise<CallToolResult> {
    if ("refusal" in calling) return refused(calling.refusal);
    const state = retryStateOf(payload);
    const { caller } = calling;
    const database = options.database;
    if (state === undefined || statesOf() === undefined || state.call !== callDigest(name, args) || database === undefined) return refused(stateRefused());
    if (caller.kind !== "oauth_token" && caller.kind !== "personal_access_token") return refused(stateRefused());
    const definition = operations.get(name);
    try {
      const { proposal, applied, teams } = await withOrg(
        database,
        async (context) => {
          const view = await proposalView(context, state.proposal);
          const own = view.state === "applied" && definition !== undefined ? await appliedOutput(definition, context, view.request.id) : undefined;
          return { proposal: view, applied: own, teams: (await teamsOfMember(context, caller.userId)).map(({ key }) => key) };
        },
        {
          readOnly: true,
          forUser: caller.userId,
          personalAccessToken: caller.kind === "personal_access_token",
          issuedAt: caller.kind === "oauth_token" ? caller.issuedAt : undefined,
        },
      );
      const render = definition === undefined ? undefined : texts[definition.id];
      const own = applied === undefined || render === undefined ? undefined : { output: agentJson(applied) as Record<string, unknown>, render };
      const output = agentJson({ ...(own?.output ?? {}), proposal }) as Record<string, unknown>;
      const markdown = createAgentView().markdown(retriedTexts(output["proposal"], own, { teams }));
      return { content: [{ type: "text", text: markdown }], structuredContent: output };
    } catch (error) {
      if (error instanceof Refusal) return refused(error);
      logger.error("mcp: the retry failed", { error });
      return failed();
    }
  }

  /**
   * The refusal of a retried tool call whose request state is not valid for
   * it, found before the SDK sees the call: one that was changed, that has
   * expired, that is bound to another user or client, or that was issued for
   * another call; none when the body retries no call with a state, or every
   * state it carries is valid. A removed member's retry is not checked here:
   * the tool call answers with the removal as a tool error, as every tool
   * call of theirs does.
   */
  async function stateRefusal(calling: Calling, binding: string | undefined, body: Uint8Array): Promise<Refusal | undefined> {
    const retries = retriedCalls(body);
    if (retries.length === 0 || "refusal" in calling) return undefined;
    const codec = statesOf();
    for (const { name, args, state } of retries) {
      if (codec === undefined || binding === undefined || typeof state !== "string") return stateRefused();
      try {
        const payload = retryStateOf(await codec.verify(state, bindingContext(binding)));
        if (payload === undefined || payload.call !== callDigest(name, args)) return stateRefused();
      } catch {
        // The codec says why only as a fixed reason code, which the refusal need not repeat.
        return stateRefused();
      }
    }
    return undefined;
  }

  // One fresh server per call, for whoever the route found the call acts for, on either protocol version.
  const handler: McpHttpHandler = createMcpHandler(
    ({ authInfo, era }) => {
      const calling = (authInfo as CallingInfo | undefined)?.extra.calling;
      if (calling === undefined) throw new Error("The MCP route hands every call to the SDK with whoever it acts for.");
      const codec = statesOf();
      // A retry's state is checked by the codec before the tool's handler runs; a state that fails is refused.
      // A removed member's state is not checked at all: their tool calls get the removal.
      const verify = codec === undefined || "refusal" in calling ? {} : { requestState: { verify: codec.verify } };
      const server = new Server({ name: MCP_SERVER_NAME, version }, { capabilities: { tools: {} }, ...verify });
      server.setRequestHandler("tools/list", async () => ({ tools: listed }));
      server.setRequestHandler("tools/call", async (request, context) =>
        answerToolCall(calling, era, request.params.name, request.params.arguments, context),
      );
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
      const binding = retryBinding(caller);
      authInfo = {
        // The token itself is not handed on: nothing past the check needs it.
        token: "",
        clientId: caller.kind === "oauth_token" ? caller.clientId : caller.kind,
        scopes: caller.kind === "oauth_token" || caller.kind === "personal_access_token" ? [...caller.scopes] : [],
        extra: { calling, ...(binding === undefined ? {} : { binding }) },
      };
    } catch (error) {
      // A person the checks found not to be a member gets a tool error for every tool call, and no data.
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
    // A retry's request state that is not valid for it is refused here, as an HTTP status, before anything runs.
    const refusedState = await stateRefusal(calling, authInfo.extra.binding, body);
    if (refusedState !== undefined) return problem(refusedState);
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
   * caller the re-check lets through, or refuses otherwise. A removed member's
   * refusal is thrown, as the token check throws it for a personal access
   * token, so that every tool call of theirs gets it as a tool error.
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
      if (error instanceof Refusal && error.reason === "removed-member") throw error;
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

/** The operation's output as it is now, for a commitment that took effect: the applied result a retry answers with. */
const APPLIED_OUTPUTS: Readonly<Record<string, (context: OrgContext, requestId: string) => Promise<unknown>>> = {
  [setRequestStatus.id]: (context, requestId) => requestView(context, requestId),
  [proposeTool.id]: async (context, requestId) => ({ request: await requestView(context, requestId), packet: await packetRevisionOf(context, requestId) }),
};

/** The applied result of the operation, validated against its output schema; none for an operation that has no reader of it. */
async function appliedOutput(definition: CommandDefinition, context: OrgContext, requestId: string): Promise<unknown> {
  const read = APPLIED_OUTPUTS[definition.id];
  if (read === undefined) return undefined;
  const output = definition.output.safeParse(await read(context, requestId));
  return output.success ? output.data : undefined;
}

/** The tool calls of a body's JSON-RPC messages that carry a request state: each one's tool, arguments and state as sent. */
function retriedCalls(body: Uint8Array): { name: string; args: unknown; state: unknown }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return [];
  }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const retries: { name: string; args: unknown; state: unknown }[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== "tools/call" || typeof params !== "object" || params === null || !Object.hasOwn(params, "requestState")) continue;
    const { name, arguments: args, requestState } = params as { name?: unknown; arguments?: unknown; requestState?: unknown };
    retries.push({ name: typeof name === "string" ? name : "", args, state: requestState });
  }
  return retries;
}

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

/** A failure that is not one of Tiehall's own refusals, as a tool result that says nothing about itself, as REST's 500 does. */
function failed(): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(internalErrorProblem().body) }] };
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
