import { inboxRoute } from "@tiehall/commands/web";

// The web inbox (requester-loop: The web inbox): the member's update feed,
// their updates after the web inbox's own cursor, with the form that
// acknowledges them, whose POST passes the web UI's write checks. A GET reads
// through execute() in a read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return inboxRoute(process.env)(request);
}

export { handle as GET, handle as POST };
