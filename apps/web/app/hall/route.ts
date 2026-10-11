import { hallRoute } from "@tiehall/commands/web";

// The live hall (web-ui: The live hall): every member watches the requests
// between the install's teams and the people and agents at work on them. A
// GET reads hall.state through execute() in a read-only transaction, renews
// the session as opening any page does, and is sent with the live hall's
// policy, which lets its one script from the install run.

// Answered on every call, never prerendered or cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return hallRoute(process.env)(request);
}

export { handle as GET };
