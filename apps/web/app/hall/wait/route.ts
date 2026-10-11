import { hallWaitRoute } from "@tiehall/commands/web";

// The live hall's long-poll (web-ui: The live hall's reads and its
// long-poll): it holds the call until an event about a request comes after
// the cursor, or 25 seconds, and answers one JSON document; never a stream.
// It takes the web session's cookie alone and reads it without renewing it.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return hallWaitRoute(process.env)(request);
}

export { handle as GET };
