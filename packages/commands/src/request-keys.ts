import { formatRequestKey, parseRequestKey, Refusal } from "@tiehall/core";
import { requestFormerKeys, requests, teamKeyAliases, teams } from "@tiehall/db";
import { and, eq } from "drizzle-orm";
import type { OrgContext } from "./with-org.ts";

// Resolving request keys (requests: Request keys that use a renamed team key
// keep resolving; requests: Per-team request keys; teams-and-roles: Team keys;
// design.md, Design rules: Teams and roles). A key such as FE-142 names its
// request through the team whose current key is FE or which had FE before a
// rename, since an old key stays its team's alias and no other team can take
// it. The request's own key is written with its team's current key, so a key
// read through an alias names the same request under its current key, such as
// WEB-142. A key a request had before a confirmed reassignment names it too,
// under its current key, such as MOB-37 for FE-142 (requests: Reassignment
// gives a new key and the old key redirects). A key that names no request of
// the install, whatever the reason, is a record that does not exist: 404, with
// nothing about why.

/** A request that a key names, and its own key, with its team's current key. */
export interface ResolvedRequestKey {
  requestId: string;
  key: string;
}

/** Refused as a record that does not exist; the key is the caller's input, so the refusal does not repeat it. */
export function noSuchRequest(): Refusal {
  return new Refusal("record-not-found", "There is no such request.");
}

/** The team a key names now or named before a rename, with its current key; undefined when no team has had it. */
export async function teamOfKey({ tx, orgId }: OrgContext, key: string): Promise<{ id: string; key: string } | undefined> {
  const [current] = await tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.key, key)));
  if (current !== undefined) return current;
  const [alias] = await tx
    .select({ id: teams.id, key: teams.key })
    .from(teamKeyAliases)
    .innerJoin(teams, and(eq(teams.orgId, teamKeyAliases.orgId), eq(teams.id, teamKeyAliases.teamId)))
    .where(and(eq(teamKeyAliases.orgId, orgId), eq(teamKeyAliases.key, key)));
  return alias;
}

/** The request a key names, through its team's current key or an alias; 404 when it names none. */
export async function resolveRequestKey(context: OrgContext, key: string): Promise<ResolvedRequestKey> {
  const parsed = parseRequestKey(key);
  if (parsed === undefined) throw noSuchRequest();
  const team = await teamOfKey(context, parsed.teamKey);
  if (team === undefined) throw noSuchRequest();
  const [request] = await context.tx
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.orgId, context.orgId), eq(requests.targetTeamId, team.id), eq(requests.number, parsed.number)));
  if (request !== undefined) return { requestId: request.id, key: formatRequestKey(team.key, parsed.number) };
  const [moved] = await context.tx
    .select({ id: requests.id, number: requests.number, teamKey: teams.key })
    .from(requestFormerKeys)
    .innerJoin(requests, and(eq(requests.orgId, requestFormerKeys.orgId), eq(requests.id, requestFormerKeys.requestId)))
    .innerJoin(teams, and(eq(teams.orgId, requests.orgId), eq(teams.id, requests.targetTeamId)))
    .where(and(eq(requestFormerKeys.orgId, context.orgId), eq(requestFormerKeys.teamId, team.id), eq(requestFormerKeys.number, parsed.number)));
  if (moved === undefined) throw noSuchRequest();
  return { requestId: moved.id, key: formatRequestKey(moved.teamKey, moved.number) };
}
