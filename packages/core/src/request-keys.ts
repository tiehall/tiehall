import { TEAM_KEY } from "./teams.ts";

// Request keys (requests: Per-team request keys; requests: Request keys that
// use a renamed team key keep resolving; design.md, Design rules: Requests and
// events; design.md, Self-hosting decisions: S15). A request's key is its
// target team's key, a hyphen and its number in that team's count, such as
// FE-142; the number has no leading zero. A key written with a key the team
// had before a rename still names the request, and the request's own key is
// always written with the team's current key.

/** The largest request number, which the database's count holds. */
export const REQUEST_NUMBER_MAX = 2 ** 31 - 1;

/** The form of a request key. */
export const REQUEST_KEY = new RegExp(`^(${TEAM_KEY.source.slice(1, -1)})-([1-9][0-9]{0,9})$`);

/** The team key and number a request key is made of; undefined for anything that is not a request key. */
export function parseRequestKey(key: string): { teamKey: string; number: number } | undefined {
  const match = REQUEST_KEY.exec(key);
  if (match === null) return undefined;
  const number = Number(match[2]);
  if (number > REQUEST_NUMBER_MAX) return undefined;
  return { teamKey: match[1] ?? "", number };
}

/** The key of a request: its team's key and its number. */
export function formatRequestKey(teamKey: string, number: number): string {
  return `${teamKey}-${number}`;
}
