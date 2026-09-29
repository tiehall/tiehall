import type { CommandSurface, Scope } from "@tiehall/catalog";
import type { Provenance } from "@tiehall/core";

// The six kinds of caller (agent-access: Six kinds of caller; design.md,
// Design rules: Agent access). Every call to a Tiehall operation comes from
// exactly one of them, and the layer that authenticated it (the web session,
// the token check, the CI check or the worker) says which. execute() lets
// each kind run only what its kind may run, and stamps the provenance of what
// it changes from the caller, never from the payload.

/** Where an agent's call came in: MCP, the CLI (which calls REST) or REST from anything else. */
export type AgentSurface = "mcp" | "cli" | "api";

/** A signed-in user in the web UI, acting within their role. */
export interface WebSessionCaller {
  kind: "web_session";
  userId: string;
  sessionId: string;
}

/** An MCP client, or the CLI after its device flow, acting for the user who approved it. */
export interface OAuthTokenCaller {
  kind: "oauth_token";
  userId: string;
  clientId: string;
  scopes: readonly Scope[];
  surface: AgentSurface;
}

/** A personal access token, acting for the user who created it. */
export interface PersonalAccessTokenCaller {
  kind: "personal_access_token";
  userId: string;
  tokenId: string;
  scopes: readonly Scope[];
  surface: AgentSurface;
}

/** A CI run with a GitHub Actions OIDC token, acting for a registered API's repository and for no user. */
export interface CiCaller {
  kind: "ci";
  /** The repository's GitHub id, from the token's repository_id claim. */
  repositoryId: string;
}

/** One of Tiehall's own jobs in the worker, acting for no user. */
export interface SystemJobCaller {
  kind: "system_job";
  /** The job's queue name. */
  job: string;
}

/**
 * A verified GitHub or Jira webhook, or a change read from them, acting for
 * the mapped user if there is one and only while that user is a member of the
 * install, as execute() reads it in the call's transaction; otherwise for no
 * user.
 */
export interface IntegrationEventCaller {
  kind: "integration_event";
  source: "github" | "jira";
  userId?: string;
}

export type Caller =
  | WebSessionCaller
  | OAuthTokenCaller
  | PersonalAccessTokenCaller
  | CiCaller
  | SystemJobCaller
  | IntegrationEventCaller;

export type CallerKind = Caller["kind"];

/** The callers that act for a user within that user's role. */
export type UserCaller = WebSessionCaller | OAuthTokenCaller | PersonalAccessTokenCaller;

/**
 * Whether a caller acts for a user within that user's role, through a web
 * session or a token (teams-and-roles: The role bounds every caller acting
 * for a user). A job or an integration event that acts for a mapped user, such
 * as a pull request's author, does not: the user did not start it.
 */
export function actsForUser(caller: Caller): caller is UserCaller {
  return caller.kind === "web_session" || caller.kind === "oauth_token" || caller.kind === "personal_access_token";
}

/**
 * The surface of the catalog a caller's call came through: a token or CI
 * call through REST or MCP. A web session (the web UI) and the worker's
 * callers come through none, and run in-process.
 */
export function catalogSurfaceOf(caller: Caller): CommandSurface | undefined {
  switch (caller.kind) {
    case "oauth_token":
    case "personal_access_token":
      return caller.surface === "mcp" ? "mcp" : "rest";
    case "ci":
      return "rest";
    default:
      return undefined;
  }
}

/**
 * Who caused what a call changes (requests: Provenance is stamped by the
 * server), from the caller alone, never from the payload. An agent's call, one
 * made with an OAuth token or a personal access token, is recorded with the
 * actor kind `agent`, the user the token acts for as the accountable human,
 * and the surface it came through: `mcp`, `cli` for the CLI, and `api` for
 * any other call to /api/v1. An OAuth token also names its client: the
 * Client ID Metadata Document URL or the registered client's id, which for
 * the CLI is the CLI's own; a personal access token names none. A web action is
 * recorded as `web_session` on `web`, because the server cannot tell a person
 * from an agent that drives a browser, and nothing is ever recorded as
 * `human`. A CI report is a system action from GitHub (D30 (3)), a job is
 * `system` and a tracker change `integration`. The team the user acted for
 * depends on their side of the request, so the handler adds it when it writes.
 */
export function provenanceOf(caller: Caller): Provenance {
  switch (caller.kind) {
    case "web_session":
      return { actorKind: "web_session", userId: caller.userId, surface: "web" };
    case "oauth_token":
      return { actorKind: "agent", userId: caller.userId, surface: caller.surface, client: caller.clientId };
    case "personal_access_token":
      return { actorKind: "agent", userId: caller.userId, surface: caller.surface };
    case "ci":
      return { actorKind: "system", surface: "github" };
    case "system_job":
      return { actorKind: "system" };
    case "integration_event":
      return { actorKind: "integration", surface: caller.source, ...(caller.userId === undefined ? {} : { userId: caller.userId }) };
  }
}
