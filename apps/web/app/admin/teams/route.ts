import { teamsRoute } from "@tiehall/commands/web";

// The teams page of the admin UI (teams-and-roles: Teams; teams-and-roles:
// Team keys): a signed-in admin creates teams, renames them, changes their
// keys, and adds members of the install to them and removes them, with forms
// that pass the web UI's write checks. A GET reads through execute() in a
// read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return teamsRoute(process.env)(request);
}

export { handle as GET, handle as POST };
