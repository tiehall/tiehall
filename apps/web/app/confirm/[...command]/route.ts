import { confirmRoute } from "@tiehall/commands/web";

// The review pages of the confirmation step (agent-safety: The review page of
// the confirmation step; agent-safety: One confirmation approves one action):
// GET /confirm/<command id>?input=<JSON> shows exactly what the action will
// do, in Tiehall's own words, and changes nothing; its form's POST applies the
// action with the page's nonce, from the install's own origin, with the
// session's CSRF token. GET /confirm/{proposal} is a proposal's confirm page,
// whose forms confirm the proposal or reject it (requests: The proposal's
// confirm page), and /confirm/{proposal}/undo the undo page a receipt links
// (requests: The undo window for reversible commitments). The segment is a
// catch-all, so every path under /confirm reaches the one route, which reads
// the path itself; a test of the app holds it to every path the route serves.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return confirmRoute(process.env)(request);
}

export { handle as GET, handle as POST };
