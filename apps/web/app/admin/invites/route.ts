import { invitesRoute } from "@tiehall/commands/web";

// The invites page of the admin UI (teams-and-roles: Invites by GitHub
// username; teams-and-roles: Revoking an invite): a signed-in admin names a
// GitHub username and a role, and is led to the invite's review page, where
// the invite is created with the confirmation step; each invite that waits
// has a form that revokes it, which passes the web UI's write checks. A GET
// reads through execute() in a read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return invitesRoute(process.env)(request);
}

export { handle as GET, handle as POST };
