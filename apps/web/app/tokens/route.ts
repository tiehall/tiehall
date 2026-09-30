import { tokensRoute } from "@tiehall/commands/web";

// The "Connected agents and tokens" page (agent-access: Personal access tokens
// are scoped, expiring and created in the web UI): every signed-in member
// finds the form that creates a personal access token, whose POST passes the
// web UI's write checks and leads to the token's review page, where it is
// created with the confirmation step. A GET reads through execute() in a
// read-only transaction and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return tokensRoute(process.env)(request);
}

export { handle as GET, handle as POST };
