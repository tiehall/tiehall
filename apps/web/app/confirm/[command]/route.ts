import { confirmRoute } from "@tiehall/commands/web";

// The review pages of the confirmation step (agent-safety: The review page of
// the confirmation step): /confirm/<command id>?input=<JSON> shows exactly what
// the action will do, in Tiehall's own words, and changes nothing.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return confirmRoute(process.env)(request);
}
