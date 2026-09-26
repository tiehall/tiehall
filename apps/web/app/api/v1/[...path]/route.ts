import { restRoute } from "@tiehall/commands/web";

// The REST catch-all route under /api/v1 (public-api: Operations not offered on
// REST answer 404; public-api: Errors are RFC 9457 problem details;
// design.md, Technical decisions: T3): every method of every path under
// /api/v1 goes to the one route handler, which finds the operation in the
// catalog and runs it through execute().

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return restRoute(process.env)(request);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
