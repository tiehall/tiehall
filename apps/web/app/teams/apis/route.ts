import { teamApisRoute } from "@tiehall/commands/web";

// The target of the forms of a team's page (contract-changes: Teams declare
// the APIs they consume): a member of the team declares there that the team
// consumes a registered API, or removes the team's declaration, with a form
// that passes the web UI's write checks, and is led back to the team's page.
// It answers posts alone.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return teamApisRoute(process.env)(request);
}
