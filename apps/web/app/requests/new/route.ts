import { newRequestRoute } from "@tiehall/commands/web";

// The web form that opens a request (requests: A request is addressed to a
// team of the install; agent-surfaces: Admins set a team's intake notes and
// required fields): a member picks the team it goes to and the team of theirs
// it comes from, and writes its title and packet; the form's POST opens it
// through execute() and leads to its page, at its URL. Given ?team=FE, the
// form shows FE's intake notes and marks the fields FE requires.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return newRequestRoute(process.env)(request);
}

export { handle as GET, handle as POST };
