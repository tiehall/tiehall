import { consentRoute } from "@tiehall/commands/web";

// The consent screen (agent-access: The consent screen shows who is asking):
// the authorization server sends a signed-in member here with an agent
// client's authorization request, and the page says, in Tiehall's own words,
// who is asking and what for. A browser without a session is sent to sign in
// first, and comes back.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return consentRoute(process.env)(request);
}

export { handle as GET };
