import { mcpRoute } from "@tiehall/commands/web";

// The install's MCP endpoint at /mcp (agent-surfaces: One MCP endpoint for both
// protocol versions; agent-surfaces: Four agent surfaces; design.md, Technical
// decisions: T9): one stateless endpoint for clients on protocol versions
// 2026-07-28 and 2025-11-25, behind the same token check as /api/v1, offering
// tools only. Every method goes to the one handler, which answers the ones the
// protocol does not use as the MCP SDK does.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return mcpRoute(process.env)(request);
}

export { handle as DELETE, handle as GET, handle as POST };
