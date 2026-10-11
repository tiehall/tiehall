import { hallStateRoute } from "@tiehall/commands/web";

// The live hall's state (web-ui: The live hall's reads and its long-poll):
// what the hall shows now, as JSON, which the hall's script reads when it
// starts and after a reload. It takes the web session's cookie alone and
// reads it without renewing it.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return hallStateRoute(process.env)(request);
}

export { handle as GET };
