import { wellKnownRoute } from "@tiehall/commands/web";

// The discovery documents of the install's OAuth authorization server for
// agent clients (agent-access: Tiehall is the authorization server for agent
// clients; design.md, Technical decisions: T9): the protected resource
// metadata of the MCP resource, at /.well-known/oauth-protected-resource/mcp
// and /.well-known/oauth-protected-resource, and the authorization server
// metadata, at /.well-known/oauth-authorization-server. The sign-in service
// serves them; any other path under /.well-known answers 404.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return wellKnownRoute(process.env)(request);
}

export { handle as GET };
