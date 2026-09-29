import { membersRoute } from "@tiehall/commands/web";

// The members page (teams-and-roles: What admins and members may do): every
// signed-in member sees the install's members, ordered by GitHub login, with
// their role, teams and bot mark. An admin also finds the links to the review
// pages that change a role or remove a member, and the forms that set and
// clear the bot flag, which pass the web UI's write checks. A GET reads
// through execute() in a read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return membersRoute(process.env)(request);
}

export { handle as GET, handle as POST };
