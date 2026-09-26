import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AgentSurface, Caller, OAuthTokenCaller, PersonalAccessTokenCaller, WebSessionCaller } from "../../src/index.ts";
import { URL_OF_INSTALL, type TestInstall } from "./install.ts";

// Teams, callers and REST calls for the tests of requests, written as the
// owner where they set up state, and made through the real REST route and
// execute() where they act.

/** Adds a team with this key, and its name the same; returns its id. */
export async function addTeam(owner: Pick<pg.ClientBase, "query">, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>("INSERT INTO teams (org_id, key, name) SELECT id, $1, $1 FROM orgs RETURNING id", [key]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`The team ${key} was not added.`);
  return id;
}

/** Makes a member of the install a member of these teams. */
export async function joinTeams(owner: Pick<pg.ClientBase, "query">, userId: string, ...teamIds: string[]): Promise<void> {
  for (const teamId of teamIds) {
    await owner.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT id, $1, $2 FROM orgs", [teamId, userId]);
  }
}

/** A personal access token of the user, calling /api/v1 directly unless another surface is given. */
export function tokenOf(userId: string, surface: AgentSurface = "api"): PersonalAccessTokenCaller {
  return { kind: "personal_access_token", userId, tokenId: randomUUID(), scopes: ["requests:read", "requests:write"], surface };
}

/** An OAuth token of the user for a client, such as an MCP client or the CLI. */
export function oauthTokenOf(userId: string, clientId: string, surface: AgentSurface): OAuthTokenCaller {
  return { kind: "oauth_token", userId, clientId, scopes: ["requests:read", "requests:write"], surface };
}

/** A signed-in web session of the user. */
export function sessionOf(userId: string): WebSessionCaller {
  return { kind: "web_session", userId, sessionId: randomUUID() };
}

export interface ApiAnswer<T = unknown> {
  status: number;
  body: T;
}

/** Calls /api/v1 as the caller, with a JSON body for a write. */
export async function callApi<T = any>(install: TestInstall, caller: Caller, method: string, path: string, body?: unknown): Promise<ApiAnswer<T>> {
  const response = await install.api(caller)(
    new Request(`${URL_OF_INSTALL}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as T };
}

/** A request's packet with only its need, as the smallest packet a request can be opened with. */
export function packetOf(need = "Add a dark mode to the settings page."): Record<string, unknown> {
  return { schema_version: "1-beta", kind: "request", untrusted: { need } };
}

/** Opens a request as the caller through /api/v1 and returns it; fails the test on any other answer. */
export async function openRequest<T = any>(
  install: TestInstall,
  caller: Caller,
  input: { targetTeam: string; requestingTeam?: string; title?: string; packet?: unknown },
): Promise<T> {
  const answer = await callApi<T>(install, caller, "POST", "/api/v1/requests", { title: "Add a dark mode", packet: packetOf(), ...input });
  if (answer.status !== 200) throw new Error(`requests.create answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
