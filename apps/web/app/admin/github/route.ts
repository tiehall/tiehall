import { githubAdminRoute } from "@tiehall/commands/web";

// The GitHub page of the admin UI (tracker-mirrors: Admins connect GitHub
// installations with the confirmation step): a signed-in admin sees every
// installation of the install's GitHub App, connects one through its review
// page, with the confirmation step, and disconnects one with a form that
// passes the web UI's write checks. A GET reads through execute() in a
// read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return githubAdminRoute(process.env)(request);
}

export { handle as GET, handle as POST };
