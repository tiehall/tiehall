// Team keys (teams-and-roles: Team keys; design.md, Self-hosting decisions:
// S15). Each team has a key of 2 to 10 characters, the uppercase letters A to
// Z and the digits 0 to 9, that starts with a letter, such as FE or PAY2.
// Request keys and URLs start with it, as FE-142 and /FE-142 do. Every app
// path, such as /api/v1, /mcp or /setup, is lowercase, so a key never shadows
// one: /MCP is team MCP's page, and /mcp stays the MCP endpoint.

/** The form of a team key. */
export const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/** Whether a value has the form of a team key. */
export function isTeamKey(value: string): boolean {
  return TEAM_KEY.test(value);
}
